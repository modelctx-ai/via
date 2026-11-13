// What the model can call in each condition, and how its calls are carried out.
//
// native: every mounted server's tools, exposed one-to-one as model tools and forwarded to the
//         replay servers with the official MCP SDK client.
// native-deferred: the same tools, none of them loaded at the start. The model has one
//         `tool_search` tool; what a search finds is added to the tools of the following turns.
// via / mcp2cli / mcpc: one `shell` tool that runs only that program. The command line is split
//         POSIX-style and handed to the program as argv; no shell is involved anywhere.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Exec } from '../harness/exec';
import { injectedTool, nativeToolName, resultText } from '../harness/native';
import { splitCommand } from '../harness/shell';
import type { ReplayTool } from '../replay-server.mjs';
import type { EvalEnv } from './env';
import { rejectAuthCommand } from './auth-guard';
import { SHELL_TOOL, shellTool, TOOL_SEARCH, toolSearchTool, type CliProgram } from './prompts';
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

/** Tools one search loads when the model names no limit, and the most it can ask for. */
export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_MAX_LIMIT = 10;
/** A word of the tool's name counts this many times as much as a word of its description. */
const NAME_WEIGHT = 3;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Lower-case words; `listIssues`, `list_issues` and `list-issues` give the same two, and a plural its singular. */
export function searchWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/**
 * The tools a `tool_search` query finds, best first: BM25 over the words of each tool's name
 * (weighted) and description. A query that is a tool's name comes first whatever its score.
 * Deterministic: ties keep the order of `defs`. Tools that share no word with the query are left out.
 */
export function searchTools(defs: readonly ToolDef[], query: string, limit: number): ToolDef[] {
  const exact = query.trim().toLowerCase();
  const docs = defs.map((def) => {
    const words = [...Array.from({ length: NAME_WEIGHT }, () => searchWords(def.name)).flat(), ...searchWords(def.description)];
    const counts = new Map<string, number>();
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
    return { def, counts, length: words.length };
  });
  const average = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const terms = [...new Set(searchWords(query))];
  const idf = new Map(
    terms.map((term) => {
      const containing = docs.filter((d) => d.counts.has(term)).length;
      return [term, Math.log(1 + (docs.length - containing + 0.5) / (containing + 0.5))] as const;
    }),
  );
  return docs
    .map((doc, index) => {
      let score = 0;
      for (const term of terms) {
        const tf = doc.counts.get(term) ?? 0;
        if (tf > 0) score += idf.get(term)! * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / average)));
      }
      const name = doc.def.name.toLowerCase();
      return { def: doc.def, index, score, exact: name === exact || name.endsWith(`__${exact}`) };
    })
    .filter((d) => d.exact || d.score > 0)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((d) => d.def);
}

const firstLine = (text: string): string => text.split('\n', 1)[0]!.trim();

/**
 * The native-deferred condition: native MCP as a framework with deferred tool loading presents it.
 * `defs` starts as the search tool alone and grows as searches load definitions, so each turn is
 * charged for exactly the definitions loaded so far. A tool that was not loaded cannot be called.
 */
export async function deferredNativeTools(env: EvalEnv): Promise<AgentTools> {
  const all = await nativeTools(env);
  const loaded = new Set<string>();
  const defs: ToolDef[] = [toolSearchTool()];
  return {
    defs,
    close: () => all.close(),
    async call(name, input) {
      if (name !== TOOL_SEARCH) {
        if (loaded.has(name)) return all.call(name, input);
        const known = all.defs.some((d) => d.name === name);
        return {
          text: known ? `Tool ${name} is not loaded yet: find it with ${TOOL_SEARCH} first.` : `Unknown tool: ${name}`,
          isError: true,
          recorded: { tool: name, input },
        };
      }
      const fields = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
      const recorded = { tool: name, input };
      if (typeof fields.query !== 'string' || fields.query.trim() === '') return { text: 'error: `query` must be a non-empty string', isError: true, recorded };
      const wanted = typeof fields.limit === 'number' && Number.isInteger(fields.limit) && fields.limit > 0 ? fields.limit : SEARCH_DEFAULT_LIMIT;
      const found = searchTools(all.defs, fields.query, Math.min(wanted, SEARCH_MAX_LIMIT));
      if (found.length === 0) return { text: `No tools match ${JSON.stringify(fields.query)}. Try other keywords.`, isError: false, recorded };
      for (const def of found) {
        if (loaded.has(def.name)) continue;
        loaded.add(def.name);
        defs.push(def);
      }
      const lines = found.map((def) => `${def.name}: ${firstLine(def.description)}`);
      return { text: `Loaded ${found.length} tool${found.length === 1 ? '' : 's'}; call them from your next turn on:\n${lines.join('\n')}`, isError: false, recorded };
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

/** The via, mcp2cli or mcpc condition: one `shell` tool bound to `program`. */
export function cliTools(program: CliProgram, exec: Exec, env: EvalEnv): AgentTools {
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
      const blocked = rejectAuthCommand(program, words, Object.values(env.urls));
      if (blocked !== undefined) return refuse(blocked);

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
