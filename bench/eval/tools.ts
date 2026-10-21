// What the model can call in each condition, and how its calls are carried out.
//
// native: every mounted server's tools, exposed one-to-one as model tools and forwarded to the
//         replay servers with the official MCP SDK client.
// via / mcp2cli: one `shell` tool that runs only that program. The command line is split
//         POSIX-style and handed to the program as argv; no shell is involved anywhere.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Exec } from '../harness/exec';
import { injectedTool, nativeToolName, resultText } from '../harness/native';
import { splitCommand } from '../harness/shell';
import type { ReplayTool } from '../replay-server.mjs';
import type { EvalEnv } from './env';
import { SHELL_TOOL, shellTool } from './prompts';
import type { ToolDef } from './types';

/** Results larger than this are cut, identically in every condition (a safety net, not a design choice). */
export const MAX_RESULT_CHARS = 200_000;

export interface ToolResult {
  /** What the model sees. */
  text: string;
  /** Non-zero exit, `isError`, or a call no canned result answered. */
  isError: boolean;
  /** The call as recorded in the result file: the input object, or the command line. */
  recorded: unknown;
}

export interface AgentTools {
  defs: ToolDef[];
  call(name: string, input: unknown): Promise<ToolResult>;
  close(): Promise<void>;
}

const clip = (text: string): string => (text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[output truncated]` : text);

/** The native condition: `tools/list` of every mounted server, called through MCP clients. */
export async function nativeTools(env: EvalEnv): Promise<AgentTools> {
  const clients = new Map<string, Client>();
  const routes = new Map<string, { server: string; tool: string }>();
  const defs: ToolDef[] = [];
  const close = async (): Promise<void> => void (await Promise.all([...clients.values()].map((c) => c.close().catch(() => undefined))));
  try {
    for (const [server, url] of Object.entries(env.urls)) {
      const client = new Client({ name: 'via-bench-eval', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      clients.set(server, client);
      for (const tool of (await client.listTools()).tools as ReplayTool[]) {
        const injected = injectedTool(server, tool);
        defs.push({ name: String(injected.name), description: String(injected.description), input_schema: injected.input_schema as Record<string, unknown> });
        routes.set(nativeToolName(server, tool.name), { server, tool: tool.name });
      }
    }
  } catch (error) {
    await close();
    throw error;
  }
  return {
    defs,
    close,
    async call(name, input) {
      const route = routes.get(name);
      const recorded = { tool: name, input };
      if (!route) return { text: `Unknown tool: ${name}`, isError: true, recorded };
      const args = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
      try {
        const result = await clients.get(route.server)!.callTool({ name: route.tool, arguments: args });
        return { text: clip(resultText(result.content as Array<Record<string, unknown>>)), isError: Boolean(result.isError), recorded };
      } catch (error) {
        return { text: `Tool call failed: ${error instanceof Error ? error.message : String(error)}`, isError: true, recorded };
      }
    },
  };
}

/** Words that would be shell syntax; with no shell they would reach the program as plain arguments. */
const SHELL_OPERATORS = new Set(['|', '||', '&', '&&', ';', '>', '>>', '<', '<<', '2>', '2>&1', '&>']);

/** What a shell tool call returns to the model: stdout, then stderr if any, then the exit code. */
export function formatCommandResult(result: { code: number; stdout: string; stderr: string }): string {
  const stderr = result.stderr.length > 0 ? `\n[stderr]\n${result.stderr}` : '';
  return `${clip(result.stdout + stderr)}\n[exit code: ${result.code}]`;
}

/** The via or mcp2cli condition: one `shell` tool bound to `program`. */
export function cliTools(program: 'via' | 'mcp2cli', exec: Exec, env: EvalEnv): AgentTools {
  return {
    defs: [shellTool(program)],
    async close() {},
    async call(name, input) {
      const command = input !== null && typeof input === 'object' ? (input as Record<string, unknown>).command : undefined;
      const recorded = typeof command === 'string' ? command : input;
      const refuse = (message: string): ToolResult => ({ text: `${message}\n[exit code: 127]`, isError: true, recorded });
      if (name !== SHELL_TOOL) return { text: `Unknown tool: ${name}`, isError: true, recorded };
      if (typeof command !== 'string') return refuse('error: `command` must be a string');
      let words: string[];
      try {
        words = splitCommand(command);
      } catch (error) {
        return refuse(`error: ${(error as Error).message}`);
      }
      if (words[0] !== program) return refuse(`error: only \`${program}\` commands can be run (got \`${words[0] ?? ''}\`)`);
      const operator = words.find((w) => SHELL_OPERATORS.has(w));
      if (operator !== undefined) return refuse(`error: \`${operator}\` is shell syntax and there is no shell; run one \`${program}\` command per call`);

      const unmatchedBefore = env.unmatched();
      const result = await exec(words.slice(1));
      return {
        text: formatCommandResult(result),
        isError: result.code !== 0 || env.unmatched() > unmatchedBefore,
        recorded,
      };
    },
  };
}
