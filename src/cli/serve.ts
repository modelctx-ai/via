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

const INSTRUCTIONS = `via gives you the user's MCP servers' tools on demand, without loading their schemas up front.
Flow: via_find (or via_browse: "" lists providers, "gh" its resources, "gh issue" the verbs with signatures, "gh issue:read" one tool's usage) then via_call. Each via_find result has an example: line to adapt.
Names: via_browse and via_find print "gh issue:read"; via_call takes "gh/issue:read" with every tool parameter inside args. A colon marks a tool; browsing it shows its usage and runs nothing.
Outputs and hints use CLI syntax: "via <provider> ..." is via_browse, "via call ..." is via_call, "via more <cursor>" is via_more (the cursor only), "via resources|read|prompts|skills|tasks ..." are the matching via_* tools, "--complete" is complete, "--detach" is detach, "--timeout" is timeout.
A failure ends with a next: line; follow it. Exit 2: fix the arguments and retry. 3: not found, see the candidates. 4: the user must log in; you cannot. 5: refused (deny rule, untrusted config, or a destructive tool: pass yes: true only if the user intends it).
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
    description:
      'Discover what exists: "" lists providers, "gh" its resources, "gh issue" a resource\'s verbs with signatures, "gh issue:read" the usage of one tool (nothing is run). Example: {"path": "gh issue"}. Words are separated by spaces, never "/".',
    inputSchema: object({ path: str('"", "<provider>", "<provider> <resource>" or "<provider> <resource>:<verb>", as printed') }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'via_find',
    description:
      'Search the tools of all providers by what they do. Example: {"query": "create issue"}. Results carry signatures and an example: line to adapt. Plain words, not a regex or an exact name.',
    inputSchema: object({ query: str('What the tool should do'), limit: { type: 'integer', minimum: 1, description: 'Default 10' } }, ['query']),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'via_call',
    description:
      'Run one tool. It neither searches nor lists: get the name and parameters from via_find or via_browse first. Example: {"tool": "gh/issue:read", "args": {"owner": "acme", "repo": "api", "issue_number": 1}}. tool has no spaces; every tool parameter goes inside args. A tool marked destructive (by the server, or inferred from a name like delete) needs yes: true (else exit 5). On failure follow the next: line. For a slow job pass detach: true, then use via_tasks.',
    inputSchema: object(
      {
        tool: str('"<provider>/<resource>:<verb>" or "<provider>/<leaf-tool>", e.g. "linear/issue:create"'),
        args: { type: 'object', description: 'Object (not a JSON string) of the tool\'s parameters, by schema name', additionalProperties: true },
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
    description: 'Continue output that ended with "next: via more c7f2". Example: {"cursor": "c7f2"}. A cursor lasts 30 minutes (then exit 3: rerun the call) and cannot page a new query.',
    inputSchema: object({ cursor: str('The code after "via more"') }, ['cursor']),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'via_resources',
    description:
      'List a provider\'s MCP resources and URI templates (via_browse shows an also: line when it has any); with template and complete, suggest values for a variable. Example: {"provider": "gh"}.',
    inputSchema: object(
      {
        provider: str('Provider'),
        template: str('Listed URI template'),
        args: { type: 'object', description: 'Variables typed so far (strings)', additionalProperties: { type: 'string' } },
        complete: str('Variable to complete (needs template)'),
      },
      ['provider'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'via_read',
    description: 'Read one MCP resource. Example: {"provider": "gh", "uri": "file:///project/README.md"}. uri comes from via_resources, placeholders filled in; a file path is not one.',
    inputSchema: object({ provider: str('Provider'), uri: str('Resource URI') }, ['provider', 'uri']),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'via_prompts',
    description:
      'List a provider\'s MCP prompts; with name get that prompt, with name and complete suggest values for an argument. Example: {"provider": "gh", "name": "greet_user", "args": {"name": "Ada"}}.',
    inputSchema: object(
      {
        provider: str('Provider'),
        name: str('Prompt name; omit to list'),
        args: { type: 'object', description: 'Prompt arguments; every value a string', additionalProperties: { type: 'string' } },
        complete: str('Argument to complete (needs name)'),
      },
      ['provider'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'via_skills',
    description: 'List a provider\'s skills; with name read its SKILL.md, with name and file another file it names. Example: {"provider": "gh", "name": "refunds"}.',
    inputSchema: object({ provider: str('Provider'), name: str('Skill name; omit to list'), file: str('File of the skill; omit for SKILL.md') }, ['provider']),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'via_tasks',
    description:
      'Follow a job started by via_call with detach: true, or one that timed out (exit 6). Example: {"task": "gh/job/1"} waits for the result (exit 6 at the timeout: the job keeps running, call again). provider alone lists tasks; action is "status" or "cancel".',
    inputSchema: object({
      provider: str('Provider; alone, lists its tasks'),
      task: str('Task id as printed ("gh/job/1"), or "job/1" with provider'),
      action: { type: 'string', enum: ['status', 'cancel'], description: 'Omit to wait for the result' },
      timeout: seconds(`Seconds to wait (default ${TASK_WAIT_SECONDS})`),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
];

/** The built-in each meta-tool runs; `via_browse` runs the provider grammar, which `commands` does not restrict (ADR 0028). */
const TOOL_COMMAND: Readonly<Record<string, string>> = {
  via_find: 'find',
  via_call: 'call',
  via_more: 'more',
  via_resources: 'resources',
  via_read: 'read',
  via_prompts: 'prompts',
  via_skills: 'skills',
  via_tasks: 'tasks',
};

/** The meta-tools to list: those whose command `visible` keeps. A call to a hidden one still runs if the command may; a refused one is refused by the CLI. */
export function serveTools(visible: (command: string) => boolean = () => true): Tool[] {
  return SERVE_TOOLS.filter((tool) => {
    const command = TOOL_COMMAND[tool.name];
    return command === undefined || visible(command);
  });
}

/** A call the meta-tool layer rejects before any command runs: same shape as a CLI usage error. */
class ServeUsageError extends Error {}

type Input = Record<string, unknown>;

/** A value of the caller's, quoted and cut for an error message (it may be long, and may hold line breaks). */
function shown(value: string): string {
  const chars = Array.from(value);
  return JSON.stringify(chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : value);
}

/** Argument names each tool takes (from its schema), so a misplaced one is named instead of dropped. */
const PARAMETERS = new Map(SERVE_TOOLS.map((t) => [t.name, Object.keys(t.inputSchema.properties ?? {})]));

/**
 * Names the arguments the tool does not take. The usual cause is a model putting the parameters of
 * the tool it calls beside `tool` instead of inside `args`, which would run the call without them.
 */
function unknownArguments(tool: string, input: Input): void {
  const known = PARAMETERS.get(tool) ?? [];
  const extra = Object.keys(input).filter((key) => !known.includes(key));
  if (extra.length === 0) return;
  const where = tool === 'via_call' ? `; the parameters of the tool go inside args: {"tool": "...", "args": {${shown(extra[0]!)}: ...}}` : `; ${tool} takes ${known.join(', ')}`;
  throw new ServeUsageError(`unknown argument ${shown(extra[0]!)}${where}`);
}

/** Every value of an object argument must be a string (prompt arguments and template variables are). */
function stringValues(input: Input, key: string): void {
  const value = input[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  for (const [name, v] of Object.entries(value)) if (typeof v !== 'string') throw new ServeUsageError(`${key}.${name} must be a string (write ${JSON.stringify(String(v))} in quotes)`);
}

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
  if (typeof value === 'string' && /^\s*\{/.test(value)) throw new ServeUsageError(`${key} must be an object, not a JSON string: pass the object itself`);
  if (typeof value !== 'object' || Array.isArray(value)) throw new ServeUsageError(`${key} must be an object`);
  return JSON.stringify(value);
}

/** The CLI command line of one meta-tool call (ADR 0016's table). Throws ServeUsageError. */
export function commandLine(tool: string, input: Input): string[] {
  unknownArguments(tool, input);
  switch (tool) {
    case 'via_browse': {
      const words = (text(input, 'path') ?? '').split(/\s+/).filter(Boolean);
      for (const word of words) if (word.startsWith('-')) throw new ServeUsageError('path must not contain options');
      // A built-in name in first position would run that command (`trust`, `auth`), not browse.
      if (words[0] !== undefined && matchBuiltin(words[0]) !== undefined) throw new ServeUsageError(`"${words[0]}" is a via command, not a provider; use the matching via_* tool`);
      if (words[0] === 'via') throw new ServeUsageError(`path starts at the provider: ${shown(words.slice(1).join(' '))}, not "via ..."`);
      const slash = words.find((w) => w.includes('/'));
      if (slash !== undefined) throw new ServeUsageError(`path words are separated by spaces, not "/": ${shown(slash.replace('/', ' '))}`);
      if (words.length > 3) throw new ServeUsageError('path has at most three words: <provider> <resource> <resource>:<verb>');
      // Beyond the provider, the second word may name a leaf tool, which the command line would call: `-h` makes it show its usage (a resource is shown as usual).
      return words.length >= 2 ? [...words, '-h'] : words;
    }
    case 'via_find': {
      const query = text(input, 'query', true);
      const limit = input.limit;
      if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) throw new ServeUsageError('limit must be a positive integer');
      return ['find', query, ...(limit === undefined ? [] : ['-n', String(limit)])];
    }
    case 'via_call': {
      const ref = text(input, 'tool', true);
      if (/\s/.test(ref)) throw new ServeUsageError(`tool must be "<provider>/<resource>:<verb>" without spaces${/^\S+\s+\S+$/.test(ref) ? `, e.g. ${shown(ref.replace(/\s+/, '/'))}` : ''}`);
      if (ref.indexOf('/') < 1) throw new ServeUsageError(`tool must start with the provider and "/": "<provider>/${ref}"`);
      const yes = input.yes;
      if (yes !== undefined && typeof yes !== 'boolean') throw new ServeUsageError('yes must be a boolean');
      const detach = input.detach;
      if (detach !== undefined && typeof detach !== 'boolean') throw new ServeUsageError('detach must be a boolean');
      return ['call', ref, '--args', args(input, 'args') ?? '{}', ...(yes === true ? ['--yes'] : []), ...(detach === true ? ['--detach'] : []), ...timeout(input)];
    }
    case 'via_more': {
      const cursor = text(input, 'cursor', true);
      if (/\s/.test(cursor)) throw new ServeUsageError(`cursor is only the code, not the command: ${shown(cursor.trim().split(/\s+/).pop()!)}`);
      return ['more', cursor];
    }
    case 'via_resources': {
      const provider = text(input, 'provider', true);
      const template = text(input, 'template');
      const complete = text(input, 'complete');
      const json = args(input, 'args');
      stringValues(input, 'args');
      if (template === undefined) {
        if (complete !== undefined || json !== undefined) throw new ServeUsageError('complete and args need template');
        return ['resources', provider];
      }
      if (complete === undefined) throw new ServeUsageError('template needs complete');
      return ['resources', provider, template, ...(json === undefined ? [] : ['--args', json]), '--complete', complete];
    }
    case 'via_read': {
      const provider = text(input, 'provider', true);
      const uri = text(input, 'uri', true);
      if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri)) throw new ServeUsageError(`uri must be a URI with a scheme, copied from via_resources (not a path): ${shown(uri)}`);
      const placeholder = /\{[^{}]*\}/.exec(uri);
      if (placeholder) throw new ServeUsageError(`uri still has the placeholder ${shown(placeholder[0])}: fill in the template's variables first`);
      return ['read', provider, uri];
    }
    case 'via_prompts': {
      const provider = text(input, 'provider', true);
      const name = text(input, 'name');
      const json = args(input, 'args');
      stringValues(input, 'args');
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
export async function createServeServer(base: CliEnv, runner: Runner, visible?: (command: string) => boolean): Promise<Server> {
  // The SDK is loaded on demand like everywhere else in src/ (implementation.md, "启动速度").
  const { Server } = await import('@modelcontextprotocol/server');
  const server = new Server({ name: 'via', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const tools = serveTools(visible);
  server.setRequestHandler('tools/list', async () => ({ tools }));
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
