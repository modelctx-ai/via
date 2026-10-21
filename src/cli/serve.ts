// `via serve` (cli.md, "via serve"; ADR 0016): an MCP server over stdio for agents without a shell.
// It offers a fixed set of meta-tools, and each call runs one CLI command in this process with its
// output captured, so naming, argument parsing, `deny`, confirmation, redaction, rendering and
// cursors are exactly those of the CLI. Nothing here talks to an upstream server directly.
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { matchBuiltin } from './builtins';
import type { CliEnv } from './env';
import { VERSION } from './help';
import { ExitCode } from '../render/exit-codes';

/** Runs one CLI command; `run` from run.ts, injectable for tests. */
export type Runner = (argv: readonly string[], overrides: Partial<CliEnv>) => Promise<number>;

const INSTRUCTIONS = `via connects to the user's MCP servers and lets you discover their tools on demand instead of loading every schema up front.
Browse with via_browse (no path: all providers; then "<provider>", "<provider> <resource>", "<provider> <resource>:<verb>" for usage), search with via_find, call with via_call.
Outputs and hints use CLI syntax: "via <provider> ..." is via_browse, "via call ..." is via_call, "via more <cursor>" is via_more, "via resources|read|prompts ..." are via_resources, via_read and via_prompts.`;

const str = (description: string): object => ({ type: 'string', description });
const object = (properties: Record<string, object>, required: string[] = []): Tool['inputSchema'] => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

export const SERVE_TOOLS: Tool[] = [
  {
    name: 'via_browse',
    description: 'List providers, the resources and verbs of a provider, the verbs of a resource with signatures, or the usage of one tool.',
    inputSchema: object({ path: str('Empty for all providers, or "<provider>", "<provider> <resource>", "<provider> <resource>:<verb>"') }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'via_find',
    description: 'Search tools across all providers.',
    inputSchema: object({ query: str('What the tool should do, e.g. "create issue"'), limit: { type: 'integer', minimum: 1, description: 'Results to show (default 10)' } }, ['query']),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'via_call',
    description: 'Call a tool. Read its usage with via_browse first. Tools marked destructive need yes: true.',
    inputSchema: object(
      {
        tool: str('"<provider>/<resource>:<verb>", e.g. "linear/issue:create"'),
        args: { type: 'object', description: 'Tool arguments by their original names', additionalProperties: true },
        yes: { type: 'boolean', description: 'Confirm a destructive tool' },
      },
      ['tool'],
    ),
    annotations: { openWorldHint: true },
  },
  {
    name: 'via_more',
    description: 'Continue output that was truncated, with the cursor from its "via more <cursor>" hint.',
    inputSchema: object({ cursor: str('The cursor') }, ['cursor']),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'via_resources',
    description: 'List the MCP resources and resource templates of a provider.',
    inputSchema: object({ provider: str('Provider name') }, ['provider']),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'via_read',
    description: 'Read an MCP resource of a provider.',
    inputSchema: object({ provider: str('Provider name'), uri: str('Resource URI, with template placeholders filled in') }, ['provider', 'uri']),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'via_prompts',
    description: 'List the MCP prompts of a provider, or get one prompt with its arguments.',
    inputSchema: object(
      {
        provider: str('Provider name'),
        name: str('Prompt name; omit to list'),
        args: { type: 'object', description: 'Prompt arguments (strings)', additionalProperties: { type: 'string' } },
      },
      ['provider'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

/** A call the meta-tool layer rejects before any command runs: same shape as a CLI usage error. */
class ServeUsageError extends Error {}

type Input = Record<string, unknown>;

function text(input: Input, key: string, required: true): string;
function text(input: Input, key: string, required?: false): string | undefined;
function text(input: Input, key: string, required = false): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    if (required) throw new ServeUsageError(`${key} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new ServeUsageError(`${key} must be a string`);
  if (required && value.trim() === '') throw new ServeUsageError(`${key} must not be empty`);
  // Every argument becomes one word of a CLI command line, where a leading `-` is an option
  // (`--yes`, `-o raw`); a value must never be able to set one.
  if (value.startsWith('-')) throw new ServeUsageError(`${key} must not start with "-"`);
  return value;
}

function args(input: Input, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new ServeUsageError(`${key} must be an object`);
  return JSON.stringify(value);
}

/** The CLI command line of one meta-tool call (ADR 0016's table). Throws ServeUsageError. */
export function commandLine(tool: string, input: Input): string[] {
  switch (tool) {
    case 'via_browse': {
      const words = (text(input, 'path') ?? '').split(/\s+/).filter(Boolean);
      for (const word of words) if (word.startsWith('-')) throw new ServeUsageError('path must not contain options');
      // A built-in name in first position would run that command (`trust`, `auth`), not browse.
      if (words[0] !== undefined && matchBuiltin(words[0]) !== undefined) throw new ServeUsageError(`"${words[0]}" is a via command, not a provider; use the matching via_* tool`);
      if (words.length > 3) throw new ServeUsageError('path has at most three words: <provider> <resource> <resource>:<verb>');
      return words.some((w) => w.includes(':')) ? [...words, '-h'] : words;
    }
    case 'via_find': {
      const query = text(input, 'query', true);
      const limit = input.limit;
      if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) throw new ServeUsageError('limit must be a positive integer');
      return ['find', query, ...(limit === undefined ? [] : ['-n', String(limit)])];
    }
    case 'via_call': {
      const ref = text(input, 'tool', true);
      const yes = input.yes;
      if (yes !== undefined && typeof yes !== 'boolean') throw new ServeUsageError('yes must be a boolean');
      return ['call', ref, '--args', args(input, 'args') ?? '{}', ...(yes === true ? ['--yes'] : [])];
    }
    case 'via_more':
      return ['more', text(input, 'cursor', true)];
    case 'via_resources':
      return ['resources', text(input, 'provider', true)];
    case 'via_read':
      return ['read', text(input, 'provider', true), text(input, 'uri', true)];
    case 'via_prompts': {
      const provider = text(input, 'provider', true);
      const name = text(input, 'name');
      const json = args(input, 'args');
      if (name === undefined) {
        if (json !== undefined) throw new ServeUsageError('args needs name');
        return ['prompts', provider];
      }
      return ['prompts', provider, name, ...(json === undefined ? [] : ['--args', json])];
    }
    default:
      throw new ServeUsageError(`unknown tool ${tool}`);
  }
}

/**
 * The MCP server of `via serve`. `base` is the environment of the serve process: each call runs
 * the CLI with the same environment, working directory and home, with nothing to read on stdin and
 * no person to ask (`interactive: false`), its output captured into the tool result.
 */
export async function createServeServer(base: CliEnv, runner: Runner): Promise<Server> {
  // The SDK is loaded on demand like everywhere else in src/ (implementation.md, "启动速度").
  const [{ Server }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]);
  const server = new Server({ name: 'via', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: SERVE_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    let argv: string[];
    try {
      argv = commandLine(request.params.name, (request.params.arguments ?? {}) as Input);
    } catch (error) {
      if (!(error instanceof ServeUsageError)) throw error;
      return result('', `error: ${error.message}\n`, ExitCode.Usage);
    }
    let stdout = '';
    let stderr = '';
    const code = await runner(argv, {
      env: base.env,
      cwd: base.cwd,
      home: base.home,
      platform: base.platform,
      now: base.now,
      daemonCommand: base.daemonCommand,
      stdout: { write: (s: string) => void (stdout += s) },
      stderr: { write: (s: string) => void (stderr += s) },
      readStdin: async () => '',
      interactive: false,
      ask: async () => '',
    });
    return result(stdout, stderr, code);
  });
  return server;
}

function result(stdout: string, stderr: string, exitCode: number): CallToolResult {
  const content: CallToolResult['content'] = [];
  if (stdout !== '') content.push({ type: 'text', text: stdout });
  if (stderr !== '') content.push({ type: 'text', text: stderr });
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return { content, structuredContent: { exitCode }, ...(exitCode === 0 ? {} : { isError: true }) };
}
