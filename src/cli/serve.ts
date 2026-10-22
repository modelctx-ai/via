// `via serve` (cli.md, "via serve"; ADR 0016): an MCP server over stdio for agents without a shell.
// It offers a fixed set of meta-tools, and each call runs one CLI command in this process with its
// output captured, so naming, argument parsing, `deny`, confirmation, redaction, rendering and
// cursors are exactly those of the CLI. Nothing here talks to an upstream server directly.
import type { CallToolResult, JSONObject, Server, Tool } from '@modelcontextprotocol/server';
import { matchBuiltin } from './builtins';
import type { CliEnv } from './env';
import { VERSION } from './help';
import { ExitCode } from '../render/exit-codes';

/** Runs one CLI command; `run` from run.ts, injectable for tests. */
export type Runner = (argv: readonly string[], overrides: Partial<CliEnv>) => Promise<number>;

const INSTRUCTIONS = `via connects to the user's MCP servers and lets you discover their tools on demand instead of loading every schema up front.
Browse with via_browse (no path: all providers; then "<provider>", "<provider> <resource>", "<provider> <resource>:<verb>" for usage), search with via_find, call with via_call.
Outputs and hints use CLI syntax: "via <provider> ..." is via_browse, "via call ..." is via_call, "via more <cursor>" is via_more, "via resources|read|prompts|skills|tasks ..." are the matching via_* tools, "--complete" is complete, "--detach" is detach, "--timeout" is timeout.
A call that outlives its wait is not cancelled: continue it with via_tasks. For a long job pass detach: true to get its task id at once.`;

/** How long `via_tasks` waits for a task's result when the caller gives no `timeout`: below the 60 s that MCP clients commonly allow a tool call, so the answer arrives instead of the client giving up first (ADR 0024). */
export const TASK_WAIT_SECONDS = 30;

const str = (description: string): Record<string, string> => ({ type: 'string', description });
const seconds = (description: string): JSONObject => ({ type: 'number', exclusiveMinimum: 0, description });
const object = (properties: Record<string, JSONObject>, required: string[] = []): Tool['inputSchema'] => ({
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
        detach: { type: 'boolean', description: 'Return the task id at once instead of waiting' },
        timeout: seconds('Seconds to wait (default 60)'),
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
    description: 'List the MCP resources and templates of a provider, or complete a template variable.',
    inputSchema: object(
      {
        provider: str('Provider name'),
        template: str('Listed URI template to complete'),
        args: { type: 'object', description: 'Variable values typed so far', additionalProperties: { type: 'string' } },
        complete: str('Variable to complete (with template)'),
      },
      ['provider'],
    ),
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
    description: 'List the MCP prompts of a provider, get one, or complete an argument.',
    inputSchema: object(
      {
        provider: str('Provider name'),
        name: str('Prompt name; omit to list'),
        args: { type: 'object', description: 'Prompt arguments (strings)', additionalProperties: { type: 'string' } },
        complete: str('Argument to complete, the others in args (with name)'),
      },
      ['provider'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'via_skills',
    description: 'List the skills of a provider, read one, or one of its files.',
    inputSchema: object({ provider: str('Provider name'), name: str('Skill name; omit to list'), file: str('File of the skill; omit for SKILL.md') }, ['provider']),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'via_tasks',
    description: 'List the tasks of a provider, or wait for, check or cancel one.',
    inputSchema: object({
      provider: str('Provider name; alone, lists its tasks'),
      task: str('Task id as printed ("gh/job/1"), or "job/1" with provider'),
      action: { type: 'string', enum: ['status', 'cancel'], description: 'Omit to wait' },
      timeout: seconds(`Seconds to wait (default ${TASK_WAIT_SECONDS})`),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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

/** `--timeout <seconds>` from the `timeout` argument, if given. */
function timeout(input: Input): string[] {
  const value = input.timeout;
  if (value === undefined || value === null) return [];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new ServeUsageError('timeout must be a positive number of seconds');
  return ['--timeout', String(value)];
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
      const detach = input.detach;
      if (detach !== undefined && typeof detach !== 'boolean') throw new ServeUsageError('detach must be a boolean');
      return ['call', ref, '--args', args(input, 'args') ?? '{}', ...(yes === true ? ['--yes'] : []), ...(detach === true ? ['--detach'] : []), ...timeout(input)];
    }
    case 'via_more':
      return ['more', text(input, 'cursor', true)];
    case 'via_resources': {
      const provider = text(input, 'provider', true);
      const template = text(input, 'template');
      const complete = text(input, 'complete');
      const json = args(input, 'args');
      if (template === undefined) {
        if (complete !== undefined || json !== undefined) throw new ServeUsageError('complete and args need template');
        return ['resources', provider];
      }
      if (complete === undefined) throw new ServeUsageError('template needs complete');
      return ['resources', provider, template, ...(json === undefined ? [] : ['--args', json]), '--complete', complete];
    }
    case 'via_read':
      return ['read', text(input, 'provider', true), text(input, 'uri', true)];
    case 'via_prompts': {
      const provider = text(input, 'provider', true);
      const name = text(input, 'name');
      const json = args(input, 'args');
      const complete = text(input, 'complete');
      if (name === undefined) {
        if (json !== undefined) throw new ServeUsageError('args needs name');
        if (complete !== undefined) throw new ServeUsageError('complete needs name');
        return ['prompts', provider];
      }
      return ['prompts', provider, name, ...(json === undefined ? [] : ['--args', json]), ...(complete === undefined ? [] : ['--complete', complete])];
    }
    case 'via_skills': {
      const provider = text(input, 'provider', true);
      const name = text(input, 'name');
      const file = text(input, 'file');
      if (name === undefined) {
        if (file !== undefined) throw new ServeUsageError('file needs name');
        return ['skills', provider];
      }
      return ['skills', provider, name, ...(file === undefined ? [] : [file])];
    }
    case 'via_tasks': {
      const provider = text(input, 'provider');
      const task = text(input, 'task');
      const action = input.action;
      if (action !== undefined && action !== 'status' && action !== 'cancel') throw new ServeUsageError('action must be "status" or "cancel"');
      if (task === undefined) {
        if (provider === undefined) throw new ServeUsageError('provider or task is required');
        if (action !== undefined) throw new ServeUsageError('action needs task');
        return ['tasks', provider, ...timeout(input)];
      }
      // `gh/job/1` alone is the printed form; with a provider the id stands alone, like the `next:` hint's second word.
      if (provider === undefined && task.indexOf('/') < 1) throw new ServeUsageError('task must be "<provider>/<id>" as printed, or give provider');
      const wait = action === undefined && input.timeout === undefined;
      return ['tasks', ...(provider === undefined ? [task] : [provider, task]), ...(action === undefined ? [] : [`--${action}`]), ...(wait ? ['--timeout', String(TASK_WAIT_SECONDS)] : timeout(input))];
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
  const { Server } = await import('@modelcontextprotocol/server');
  const server = new Server({ name: 'via', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler('tools/list', async () => ({ tools: SERVE_TOOLS }));
  server.setRequestHandler('tools/call', async (request): Promise<CallToolResult> => {
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
