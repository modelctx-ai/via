// Normalizing the server entries of framework configs into `ServerDef` (config.md, "合并规则").
//
// Frameworks spell the same ideas differently (`type`/`transport`, `url`/`serverUrl`/`httpUrl`,
// `headers`/`http_headers`, Codex's `*_env_var` fields). The accepted spellings are handled in one place for
// every framework; nothing here is specific to a server or a gateway (ADR 0007). The one syntax
// that cannot be applied to every framework, a bare `$NAME` meaning an environment variable, is
// switched on per config file by the framework's data file (`dollarVariables`).
// Framework-side switches that only mean "this framework does not load the server" (`disabled`,
// `enabled`) are ignored on purpose: switching a server off there is how people migrate to via.

import type { ConfigDiagnostic } from './diagnostics';
import { isPlainObject, ownEntries, type ServerDef } from './model';

const STDIO_TYPES = new Set(['stdio', 'local']);
const HTTP_TYPES = new Set(['http', 'streamable-http', 'streamablehttp', 'streamable_http', 'remote']);
const LEGACY_SSE_TYPES = new Set(['sse']);

export interface NormalizeOptions {
  /** Treat a whole value of the form `$NAME` as the reference `env:NAME` (data/frameworks `dollarVariables`). */
  dollarVariables?: boolean;
}

export interface NormalizeResult {
  def?: ServerDef;
  diagnostics: ConfigDiagnostic[];
}

function scalarToString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** `${NAME}` and `${env:NAME}` (and `$NAME` when enabled) as a whole value become the reference `env:NAME`. */
function convertVariable(value: string, options: NormalizeOptions): string {
  const match = /^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value) ?? (options.dollarVariables ? /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value) : null);
  return match ? `env:${match[1]}` : value;
}

/** A variable reference that survives conversion: via cannot expand it. */
function hasVariable(value: string | undefined, options: NormalizeOptions): boolean {
  if (value === undefined) return false;
  return /\$\{[^}]*\}/.test(value) || (options.dollarVariables === true && /\$[A-Za-z_]/.test(value));
}

function stringMap(value: unknown, field: string, problems: string[], convert: NormalizeOptions | false): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    problems.push(`${field}: expected a table of strings`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of ownEntries(value)) {
    const s = scalarToString(raw);
    if (s === undefined) {
      problems.push(`${field}.${key}: expected a string`);
      continue;
    }
    Object.defineProperty(out, key, { value: convert ? convertVariable(s, convert) : s, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function stringList(value: unknown, field: string, problems: string[]): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    problems.push(`${field}: expected a list of strings`);
    return undefined;
  }
  const out: string[] = [];
  for (const [i, item] of value.entries()) {
    const s = scalarToString(item);
    if (s === undefined) problems.push(`${field}[${i}]: expected a string`);
    else out.push(s);
  }
  return out;
}

/**
 * Codex: `env_vars` lists names of variables of the parent environment to pass through. An item is
 * a name, or `{ name, source }`; `source = "remote"` reads the remote executor's environment, which
 * via cannot see.
 */
function envVarNames(value: unknown, problems: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push('env_vars: expected a list');
    return [];
  }
  const names: string[] = [];
  for (const [i, item] of value.entries()) {
    if (typeof item === 'string' && item !== '') names.push(item);
    else if (isPlainObject(item) && typeof item.name === 'string' && item.name !== '') {
      if (item.source === undefined || item.source === 'local') names.push(item.name);
      else problems.push(`env_vars[${i}]: source "${typeof item.source === 'string' ? item.source : '?'}" is not available to via`);
    } else problems.push(`env_vars[${i}]: expected a name or { name, source }`);
  }
  return names;
}

function firstString(entry: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** Variable references that survive conversion cannot be expanded by via; say so. */
function unexpanded(def: ServerDef, options: NormalizeOptions): string[] {
  const hits: string[] = [];
  const check = (field: string, value: string | undefined): void => {
    if (hasVariable(value, options)) hits.push(field);
  };
  check('command', def.command);
  check('cwd', def.cwd);
  check('url', def.url);
  def.args?.forEach((a, i) => check(`args[${i}]`, a));
  for (const [k, v] of Object.entries(def.env ?? {})) check(`env.${k}`, v);
  for (const [k, v] of Object.entries(def.headers ?? {})) check(`headers.${k}`, v);
  return hits;
}

export function normalizeFrameworkEntry(name: string, entry: unknown, file: string, options: NormalizeOptions = {}): NormalizeResult {
  const diagnostics: ConfigDiagnostic[] = [];
  const diag = (level: ConfigDiagnostic['level'], code: ConfigDiagnostic['code'], message: string): void => {
    diagnostics.push({ level, code, message: `servers.${name}: ${message}`, file, server: name });
  };
  if (!isPlainObject(entry)) {
    diag('error', 'invalid-server', 'expected a table with command or url');
    return { diagnostics };
  }

  const problems: string[] = [];
  const declared = firstString(entry, ['type', 'transport']);
  const type = declared?.toLowerCase();
  const command = typeof entry.command === 'string' && entry.command !== '' ? entry.command : undefined;
  const url = firstString(entry, ['url', 'serverUrl', 'httpUrl']);

  let kind: 'stdio' | 'http';
  if (type !== undefined) {
    if (STDIO_TYPES.has(type)) kind = 'stdio';
    else if (HTTP_TYPES.has(type)) kind = 'http';
    else if (LEGACY_SSE_TYPES.has(type)) {
      kind = 'http';
      diag('warning', 'legacy-transport', 'transport "sse" is the legacy HTTP+SSE transport; via connects with Streamable HTTP');
    } else {
      diag('error', 'invalid-server', `unsupported transport "${declared}"`);
      return { diagnostics };
    }
  } else if (command !== undefined && url === undefined) kind = 'stdio';
  else if (url !== undefined && command === undefined) kind = 'http';
  else {
    diag('error', 'invalid-server', command !== undefined ? 'has both command and url and no type' : 'has neither command nor url');
    return { diagnostics };
  }

  const def: ServerDef = {};
  if (kind === 'stdio') {
    if (command === undefined) {
      diag('error', 'invalid-server', 'stdio server without command');
      return { diagnostics };
    }
    def.command = command;
    def.args = stringList(entry.args, 'args', problems) ?? [];
    const env = stringMap(entry.env, 'env', problems, options) ?? {};
    // Codex: `env_vars = ["NAME"]` passes the named variables of the parent environment through.
    for (const name_ of envVarNames(entry.env_vars, problems)) {
      if (!Object.hasOwn(env, name_)) Object.defineProperty(env, name_, { value: `env:${name_}`, enumerable: true, writable: true, configurable: true });
    }
    def.env = env;
    if (typeof entry.cwd === 'string' && entry.cwd !== '') def.cwd = entry.cwd;
  } else {
    if (url === undefined) {
      diag('error', 'invalid-server', 'http server without url');
      return { diagnostics };
    }
    def.url = url;
    const headers = stringMap(entry.headers, 'headers', problems, options) ?? stringMap(entry.http_headers, 'http_headers', problems, options) ?? {};
    // Codex: `env_http_headers = { "X-Key" = "NAME" }` takes header values from the environment.
    const fromEnv = stringMap(entry.env_http_headers, 'env_http_headers', problems, false) ?? {};
    for (const [header, variable] of Object.entries(fromEnv)) Object.defineProperty(headers, header, { value: `env:${variable}`, enumerable: true, writable: true, configurable: true });
    def.headers = headers;
    // Codex: `bearer_token_env_var = "NAME"`.
    if (typeof entry.bearer_token_env_var === 'string' && entry.bearer_token_env_var !== '') {
      def.auth = { type: 'bearer', bearer: `env:${entry.bearer_token_env_var}` };
    }
  }
  for (const problem of problems) diag('warning', 'invalid-field', problem);
  const hits = unexpanded(def, options);
  if (hits.length > 0) {
    diag('warning', 'unexpanded-variable', `unexpanded \${...} variables in ${hits.join(', ')} (via only converts whole env and header values like \${NAME} to env:NAME)`);
  }
  return { def, diagnostics };
}
