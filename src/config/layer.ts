// Validation of via's own configuration (user `config.yaml`, project `.via.yaml`, CLI overrides)
// against the field reference in config.md. Problems are reported with their path, e.g.
// `servers.github.timeout: expected number`, and the offending field is left out.

import type { ConfigDiagnostic, DiagnosticCode, DiagnosticLevel } from './diagnostics';
import { isPlainObject, ownEntries, type ServerDef } from './model';
import { parseCredentialRef } from './credential-ref';
import { isProtocolVersion, PROTOCOL_VERSIONS } from '../protocol-versions';
import { ACTIVE_COMMANDS } from '../cli/builtins';
import type { AuthConfig, SemanticSearchConfig } from './types';

/** `sources` as written: `auto`, `false`, or a list of framework ids and file paths. */
export type SourcesSetting = 'auto' | false | string[];

/** The validated content of one via config file. Absent fields were not set. */
export interface ConfigLayerData {
  sources?: SourcesSetting;
  servers: Map<string, ServerDef>;
  deny: string[];
  output: { budget?: number; cellWidth?: number };
  daemon: { idleTimeout?: number; serverIdleTimeout?: number };
  /** `discovery.wait`: seconds a discovery command waits for one server (daemon mode). */
  discovery: { wait?: number };
  /** `search.semantic`: the validated fields, `false` to switch it off, absent when not set. */
  search: { semantic?: SemanticLayer | false };
  /** `commands`: which built-in subcommands may run and which are shown (ADR 0028). Names are canonical. */
  commands: CommandsLayer;
  /** `sandbox`: run via inside a sandbox program such as srt (ADR 0027). */
  sandbox: SandboxLayer;
}

/** The `commands` lists as written, names lower-cased; absent lists were not set. */
export interface CommandsLayer {
  allow?: string[];
  deny?: string[];
  hide?: string[];
  show?: string[];
}

/** The `sandbox` fields as written; `policy` is either the settings themselves or a path to a JSON file of them. */
export interface SandboxLayer {
  enabled?: boolean;
  command?: string[];
  policy?: Record<string, unknown> | string;
  exclude?: string[];
}

/** The `search.semantic` fields as written (defaults are applied when the layers are merged). */
export type SemanticLayer = Pick<SemanticSearchConfig, 'url' | 'model' | 'auth'> &
  Partial<Pick<SemanticSearchConfig, 'timeout' | 'indexTimeout' | 'dimensions'>>;

const TOP_LEVEL = new Set(['sources', 'servers', 'deny', 'output', 'daemon', 'discovery', 'search', 'commands', 'sandbox']);
const SERVER_FIELDS = new Set(['command', 'args', 'env', 'cwd', 'url', 'headers', 'auth', 'alias', 'rename', 'disabled', 'exclusive', 'confirm', 'timeout', 'concurrency', 'budget', 'noise', 'roots', 'protocolVersion']);

const typeName = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v);

class Reporter {
  readonly diagnostics: ConfigDiagnostic[] = [];
  constructor(private readonly file: string | undefined) {}
  add(level: DiagnosticLevel, code: DiagnosticCode, path: string, message: string, server?: string): void {
    const d: ConfigDiagnostic = { level, code, message: `${path}: ${message}` };
    if (this.file !== undefined) d.file = this.file;
    if (server !== undefined) d.server = server;
    this.diagnostics.push(d);
  }
  invalid(path: string, expected: string, server?: string): void {
    this.add('error', 'invalid-field', path, `expected ${expected}`, server);
  }
}

function str(r: Reporter, path: string, v: unknown, server?: string): string | undefined {
  if (typeof v === 'string' && v !== '') return v;
  r.invalid(path, 'non-empty string', server);
  return undefined;
}

function bool(r: Reporter, path: string, v: unknown, server?: string): boolean | undefined {
  if (typeof v === 'boolean') return v;
  r.invalid(path, 'boolean', server);
  return undefined;
}

function num(r: Reporter, path: string, v: unknown, kind: 'number' | 'integer', server?: string): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && (kind === 'number' || Number.isInteger(v))) return v;
  r.invalid(path, kind === 'integer' ? 'positive integer' : typeof v === 'number' ? 'positive number' : 'number', server);
  return undefined;
}

function scalarString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/** A table of strings; numbers and booleans are accepted and written as text (`PORT: 8080`). */
function strMap(r: Reporter, path: string, v: unknown, server?: string): Record<string, string> | undefined {
  if (!isPlainObject(v)) {
    r.invalid(path, 'map of strings', server);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of ownEntries(v)) {
    const s = scalarString(raw);
    if (s === undefined) r.invalid(`${path}.${key}`, 'string', server);
    else Object.defineProperty(out, key, { value: s, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function strList(r: Reporter, path: string, v: unknown, server?: string, scalars = false): string[] | undefined {
  if (!Array.isArray(v)) {
    r.invalid(path, 'list of strings', server);
    return undefined;
  }
  const out: string[] = [];
  for (const [i, item] of v.entries()) {
    const s = scalars ? scalarString(item) : typeof item === 'string' ? item : undefined;
    if (s === undefined) r.invalid(`${path}[${i}]`, 'string', server);
    else out.push(s);
  }
  return out;
}

/** `roots`: paths or `file://` URIs. Any other URI scheme is refused: MCP roots are file URIs. */
function roots(r: Reporter, path: string, v: unknown, server: string): string[] | undefined {
  const list = strList(r, path, v, server);
  if (list === undefined) return undefined;
  const out: string[] = [];
  for (const [i, item] of list.entries()) {
    if (item === '') r.invalid(`${path}[${i}]`, 'non-empty path or file:// URI', server);
    else if (/^[a-z][a-z0-9+.-]+:\/\//i.test(item) && !/^file:\/\//i.test(item)) r.invalid(`${path}[${i}]`, 'a path or file:// URI', server);
    else out.push(item);
  }
  return out;
}

function auth(r: Reporter, path: string, v: unknown, server?: string): AuthConfig | undefined {
  const shapes = 'none, oauth, or a map with one of bearer, headers, oauth';
  if (v === 'none') return { type: 'none' };
  if (v === 'oauth') return { type: 'oauth' };
  if (!isPlainObject(v)) {
    r.invalid(path, shapes, server);
    return undefined;
  }
  const keys = ownEntries(v).map(([k]) => k);
  const known: string[] = keys.filter((k) => k === 'bearer' || k === 'headers' || k === 'oauth' || k === 'none');
  for (const k of keys) if (!known.includes(k)) r.add('warning', 'unknown-field', `${path}.${k}`, 'unknown field', server);
  if (known.length !== 1) {
    r.invalid(path, shapes, server);
    return undefined;
  }
  switch (known[0]) {
    case 'none':
      return { type: 'none' };
    case 'bearer': {
      const bearer = str(r, `${path}.bearer`, v.bearer, server);
      if (bearer === undefined) return undefined;
      if (parseCredentialRef(bearer).kind === 'literal') {
        r.add('warning', 'plaintext-credential', `${path}.bearer`, 'is a literal value; use env:, file: or keychain: so the token is not stored in the config', server);
      }
      return { type: 'bearer', bearer };
    }
    case 'headers': {
      const headers = strMap(r, `${path}.headers`, v.headers, server);
      if (headers === undefined) return undefined;
      for (const [k, value] of Object.entries(headers)) {
        if (parseCredentialRef(value).kind === 'literal') {
          r.add('warning', 'plaintext-credential', `${path}.headers.${k}`, 'is a literal value; use env:, file: or keychain:', server);
        }
      }
      return { type: 'headers', headers };
    }
    default: {
      const o = v.oauth;
      if (o === null || o === true || o === undefined) return { type: 'oauth' };
      if (!isPlainObject(o)) {
        r.invalid(`${path}.oauth`, 'map with scopes, clientId, clientMetadataUrl and issuer', server);
        return undefined;
      }
      const result: AuthConfig & { type: 'oauth' } = { type: 'oauth' };
      for (const [k, val] of ownEntries(o)) {
        if (k === 'scopes') {
          const scopes = strList(r, `${path}.oauth.scopes`, val, server);
          if (scopes) result.scopes = scopes;
        } else if (k === 'clientId') {
          const clientId = str(r, `${path}.oauth.clientId`, val, server);
          if (clientId) result.clientId = clientId;
        } else if (k === 'clientMetadataUrl') {
          const field = `${path}.oauth.clientMetadataUrl`;
          if (val === false) result.clientMetadataUrl = false;
          else {
            const url = str(r, field, val, server);
            if (url !== undefined) {
              if (isClientMetadataUrl(url)) result.clientMetadataUrl = url;
              else r.invalid(field, 'https URL with a path (no credentials, no fragment), or false', server);
            }
          }
        } else if (k === 'issuer') {
          const field = `${path}.oauth.issuer`;
          const issuer = str(r, field, val, server);
          if (issuer !== undefined) {
            if (isIssuerIdentifier(issuer)) result.issuer = issuer;
            else r.invalid(field, 'issuer URL: https (http only for a loopback host), no query, no fragment, no credentials', server);
          }
        } else if (k === 'grant') {
          if (val === 'client_credentials') result.grant = 'client_credentials';
          else if (val !== 'authorization_code') r.invalid(`${path}.oauth.grant`, '"authorization_code" or "client_credentials"', server);
        } else if (k === 'clientSecret' || k === 'privateKey') {
          const ref = str(r, `${path}.oauth.${k}`, val, server);
          if (ref === undefined) continue;
          if (parseCredentialRef(ref).kind === 'literal') {
            r.add('warning', 'plaintext-credential', `${path}.oauth.${k}`, 'is a literal value; use env:, file: or keychain:', server);
          }
          result[k] = ref;
        } else if (k === 'keyAlgorithm') {
          if (typeof val === 'string' && KEY_ALGORITHMS.includes(val)) result.keyAlgorithm = val;
          else r.invalid(`${path}.oauth.keyAlgorithm`, `one of ${KEY_ALGORITHMS.join(', ')}`, server);
        } else r.add('warning', 'unknown-field', `${path}.oauth.${k}`, 'unknown field', server);
      }
      return oauthShape(r, `${path}.oauth`, result, server);
    }
  }
}

/** JWS algorithms for the client assertion that the SDK can sign with a PEM key. */
const KEY_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];

/**
 * Cross-field rules of `auth.oauth` (auth.md, "OAuth client credentials"): the client-credentials grant needs a
 * client id and exactly one way to authenticate; a secret belongs to a client id; a key only to that grant.
 * Returns undefined (and reports) when the combination cannot work.
 */
function oauthShape(r: Reporter, path: string, oauth: AuthConfig & { type: 'oauth' }, server: string | undefined): AuthConfig | undefined {
  let problem: [field: string, expected: string] | undefined;
  if (oauth.grant === 'client_credentials') {
    if (oauth.clientId === undefined) problem = ['clientId', 'a client id (required with grant: client_credentials)'];
    else if ((oauth.clientSecret === undefined) === (oauth.privateKey === undefined)) problem = ['', 'exactly one of clientSecret and privateKey with grant: client_credentials'];
  } else if (oauth.privateKey !== undefined) {
    problem = ['privateKey', 'grant: client_credentials (a private key signs the client assertion of that grant only)'];
  } else if (oauth.clientSecret !== undefined && oauth.clientId === undefined) {
    problem = ['clientSecret', 'a clientId next to it'];
  }
  if (!problem && oauth.keyAlgorithm !== undefined && oauth.privateKey === undefined) problem = ['keyAlgorithm', 'a privateKey next to it'];
  if (!problem) return oauth;
  r.invalid(problem[0] === '' ? path : `${path}.${problem[0]}`, problem[1], server);
  return undefined;
}

/** A CIMD `client_id` (draft-ietf-oauth-client-id-metadata-document): https, a path, no userinfo, no fragment. */
function isClientMetadataUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.pathname !== '/' && url.username === '' && url.password === '' && url.hash === '' && !value.includes('#');
  } catch {
    return false;
  }
}

/**
 * An authorization server issuer identifier (RFC 8414, section 2): an https URL without query or fragment. `http` is
 * accepted for a loopback host only (a local test or development server), as for `search.semantic.url`.
 */
function isIssuerIdentifier(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username !== '' || url.password !== '' || url.search !== '' || value.includes('?') || url.hash !== '' || value.includes('#')) return false;
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
  } catch {
    return false;
  }
}

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** `search.semantic` (config.md): url, model and the optional auth, timeouts and dimensions. */
function semanticLayer(r: Reporter, path: string, v: unknown): SemanticLayer | false | undefined {
  if (v === false) return false;
  if (!isPlainObject(v)) {
    r.invalid(path, 'map (or false)');
    return undefined;
  }
  const out: Partial<SemanticLayer> = {};
  let ok = true;
  for (const [key, value] of ownEntries(v)) {
    const field = `${path}.${key}`;
    switch (key) {
      case 'provider':
        if (value !== 'openai-compatible') {
          r.invalid(field, '"openai-compatible"');
          ok = false;
        }
        break;
      case 'url': {
        const url = str(r, field, value);
        if (url === undefined) {
          ok = false;
          break;
        }
        let parsed: URL | undefined;
        try {
          parsed = new URL(url);
        } catch {
          // reported below
        }
        const secure = parsed && (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)));
        if (!parsed || !secure) {
          r.invalid(field, 'https URL (http is accepted for localhost only)');
          ok = false;
        } else if (parsed.username !== '' || parsed.password !== '') {
          r.invalid(field, 'URL without credentials (put them in auth)');
          ok = false;
        } else out.url = url;
        break;
      }
      case 'model': {
        const model = str(r, field, value);
        if (model === undefined) ok = false;
        else out.model = model;
        break;
      }
      case 'auth': {
        const a = auth(r, field, value);
        if (a === undefined) ok = false;
        else if (a.type === 'oauth') {
          r.invalid(field, 'none, or a map with bearer or headers');
          ok = false;
        } else out.auth = a;
        break;
      }
      case 'timeout':
        out.timeout = num(r, field, value, 'number');
        break;
      case 'indexTimeout':
        out.indexTimeout = num(r, field, value, 'number');
        break;
      case 'dimensions':
        out.dimensions = num(r, field, value, 'integer');
        break;
      default:
        r.add('warning', 'unknown-field', field, 'unknown field');
    }
  }
  for (const required of ['url', 'model'] as const) {
    if (out[required] === undefined && ok) {
      r.invalid(`${path}.${required}`, 'non-empty string');
      ok = false;
    }
  }
  if (!ok) return undefined;
  for (const key of Object.keys(out) as Array<keyof SemanticLayer>) if (out[key] === undefined) delete out[key];
  return { auth: { type: 'none' }, ...out } as SemanticLayer;
}

/**
 * A list of built-in subcommand names (`commands.*`, `sandbox.exclude`), compared like the command
 * line compares them (case-insensitive, `_` equals `-`). `help` cannot be listed: it is how a person
 * or an agent learns what is left. A name via does not know is an error where it would loosen
 * nothing if dropped silently the other way round: in `deny` and `hide` a typo would leave the
 * command runnable or shown (fail closed, like an invalid `deny` rule); elsewhere it only warns.
 */
function commandNames(r: Reporter, path: string, v: unknown, unknownLevel: DiagnosticLevel): string[] | undefined {
  const list = strList(r, path, v);
  if (list === undefined) return undefined;
  const out: string[] = [];
  for (const [i, raw] of list.entries()) {
    const name = raw.trim().toLowerCase().replace(/_/g, '-');
    if (name === 'help') {
      r.add('warning', 'unknown-command', `${path}[${i}]`, 'help cannot be restricted; ignored');
    } else if (!(ACTIVE_COMMANDS as readonly string[]).includes(name)) {
      r.add(unknownLevel, 'unknown-command', `${path}[${i}]`, `${JSON.stringify(raw)} is not a via command (${ACTIVE_COMMANDS.join(', ')})`);
    } else if (!out.includes(name)) out.push(name);
  }
  return out;
}

function commandsLayer(r: Reporter, v: unknown): CommandsLayer {
  const out: CommandsLayer = {};
  if (v === null) return out;
  if (!isPlainObject(v)) {
    r.invalid('commands', 'map with allow, deny, hide or show');
    return out;
  }
  for (const [key, value] of ownEntries(v)) {
    if (key === 'allow' || key === 'show') {
      const names = commandNames(r, `commands.${key}`, value, 'warning');
      if (names !== undefined) out[key] = names;
    } else if (key === 'deny' || key === 'hide') {
      const names = commandNames(r, `commands.${key}`, value, 'error');
      if (names !== undefined) out[key] = names;
    } else r.add('warning', 'unknown-field', `commands.${key}`, 'unknown field');
  }
  return out;
}

function sandboxLayer(r: Reporter, v: unknown): SandboxLayer {
  const out: SandboxLayer = {};
  if (v === null) return out;
  if (!isPlainObject(v)) {
    r.invalid('sandbox', 'map');
    return out;
  }
  for (const [key, value] of ownEntries(v)) {
    const path = `sandbox.${key}`;
    switch (key) {
      case 'enabled': {
        const b = bool(r, path, value);
        if (b !== undefined) out.enabled = b;
        break;
      }
      case 'command': {
        const list = typeof value === 'string' ? [value] : strList(r, path, value);
        if (list === undefined) break;
        if (list.length === 0 || list.some((word) => word === '')) r.invalid(path, 'a program name, or a non-empty list of words');
        else out.command = list;
        break;
      }
      case 'policy':
        if (typeof value === 'string' && value !== '') out.policy = value;
        else if (isPlainObject(value)) out.policy = value;
        else r.invalid(path, 'map (the sandbox settings) or the path of a JSON file with them');
        break;
      case 'exclude': {
        const names = commandNames(r, path, value, 'warning');
        if (names !== undefined) out.exclude = names;
        break;
      }
      default:
        r.add('warning', 'unknown-field', path, 'unknown field');
    }
  }
  return out;
}

function serverDef(r: Reporter, name: string, v: unknown): ServerDef | undefined {
  const base = `servers.${name}`;
  if (v === null) return {};
  if (!isPlainObject(v)) {
    r.invalid(base, 'map', name);
    return undefined;
  }
  const def: ServerDef = {};
  for (const [key, value] of ownEntries(v)) {
    const path = `${base}.${key}`;
    if (key === 'domain') {
      r.add('warning', 'removed-field', path, 'domain was removed: providers are listed as they are, delete this field', name);
      continue;
    }
    if (!SERVER_FIELDS.has(key)) {
      r.add('warning', 'unknown-field', path, 'unknown field', name);
      continue;
    }
    switch (key) {
      case 'command': def.command = str(r, path, value, name); break;
      case 'cwd': def.cwd = str(r, path, value, name); break;
      case 'url': def.url = str(r, path, value, name); break;
      case 'alias': def.alias = str(r, path, value, name); break;
      case 'args': def.args = strList(r, path, value, name, true); break;
      case 'noise': def.noise = strList(r, path, value, name); break;
      case 'roots': def.roots = roots(r, path, value, name); break;
      case 'env': def.env = strMap(r, path, value, name); break;
      case 'headers': def.headers = strMap(r, path, value, name); break;
      case 'rename': def.rename = strMap(r, path, value, name); break;
      case 'disabled': def.disabled = bool(r, path, value, name); break;
      case 'exclusive': def.exclusive = bool(r, path, value, name); break;
      case 'timeout': def.timeout = num(r, path, value, 'number', name); break;
      case 'concurrency': def.concurrency = num(r, path, value, 'integer', name); break;
      case 'budget': def.budget = num(r, path, value, 'integer', name); break;
      case 'protocolVersion':
        if (typeof value === 'string' && isProtocolVersion(value)) def.protocolVersion = value;
        else r.invalid(path, `one of ${PROTOCOL_VERSIONS.join(', ')}`, name);
        break;
      case 'auth': def.auth = auth(r, path, value, name); break;
      case 'confirm':
        if (value === 'destructive' || value === 'never') def.confirm = value;
        else r.invalid(path, '"destructive" or "never"', name);
        break;
    }
  }
  // Drop keys whose value failed validation.
  for (const key of Object.keys(def) as Array<keyof ServerDef>) if (def[key] === undefined) delete def[key];
  if (def.command !== undefined && def.url !== undefined) {
    r.add('error', 'invalid-server', base, 'has both command and url; a server is either stdio or HTTP', name);
    return undefined;
  }
  return def;
}

/**
 * Validate parsed YAML (or CLI overrides). `file` labels the diagnostics. Never throws:
 * a document of the wrong shape yields an empty layer and one error.
 */
export function validateLayer(raw: unknown, file: string | undefined): { data: ConfigLayerData; diagnostics: ConfigDiagnostic[] } {
  const r = new Reporter(file);
  const data: ConfigLayerData = { servers: new Map(), deny: [], output: {}, daemon: {}, discovery: {}, search: {}, commands: {}, sandbox: {} };
  if (raw === null || raw === undefined) return { data, diagnostics: r.diagnostics };
  if (!isPlainObject(raw)) {
    r.add('error', 'invalid-field', '(root)', `expected a map at the top level, got ${typeName(raw)}`);
    return { data, diagnostics: r.diagnostics };
  }

  for (const [key, value] of ownEntries(raw)) {
    switch (key) {
      case 'sources':
        if (value === 'auto' || value === false) data.sources = value;
        else if (Array.isArray(value)) data.sources = strList(r, 'sources', value) ?? [];
        else r.invalid('sources', '"auto", false, or a list of framework ids and file paths');
        break;
      case 'servers':
        if (value === null) break;
        if (!isPlainObject(value)) {
          r.invalid('servers', 'map');
          break;
        }
        for (const [name, entry] of ownEntries(value)) {
          const def = serverDef(r, name, entry);
          if (def) data.servers.set(name, def);
        }
        break;
      case 'deny':
        data.deny = strList(r, 'deny', value) ?? [];
        break;
      case 'output':
        if (!isPlainObject(value)) {
          r.invalid('output', 'map');
          break;
        }
        for (const [k, v] of ownEntries(value)) {
          if (k === 'budget') data.output.budget = num(r, 'output.budget', v, 'integer');
          else if (k === 'cellWidth') data.output.cellWidth = num(r, 'output.cellWidth', v, 'integer');
          else r.add('warning', 'unknown-field', `output.${k}`, 'unknown field');
        }
        break;
      case 'daemon':
        if (!isPlainObject(value)) {
          r.invalid('daemon', 'map');
          break;
        }
        for (const [k, v] of ownEntries(value)) {
          if (k === 'idleTimeout') data.daemon.idleTimeout = num(r, 'daemon.idleTimeout', v, 'number');
          else if (k === 'serverIdleTimeout') data.daemon.serverIdleTimeout = num(r, 'daemon.serverIdleTimeout', v, 'number');
          else r.add('warning', 'unknown-field', `daemon.${k}`, 'unknown field');
        }
        break;
      case 'discovery':
        if (!isPlainObject(value)) {
          r.invalid('discovery', 'map');
          break;
        }
        for (const [k, v] of ownEntries(value)) {
          if (k === 'wait') data.discovery.wait = num(r, 'discovery.wait', v, 'number');
          else r.add('warning', 'unknown-field', `discovery.${k}`, 'unknown field');
        }
        break;
      case 'search':
        if (value === null) break;
        if (!isPlainObject(value)) {
          r.invalid('search', 'map');
          break;
        }
        for (const [k, v] of ownEntries(value)) {
          if (k === 'semantic') {
            const semantic = semanticLayer(r, 'search.semantic', v);
            if (semantic !== undefined) data.search.semantic = semantic;
          } else r.add('warning', 'unknown-field', `search.${k}`, 'unknown field');
        }
        break;
      case 'commands':
        data.commands = commandsLayer(r, value);
        break;
      case 'sandbox':
        data.sandbox = sandboxLayer(r, value);
        break;
      default:
        if (key === 'domains') r.add('warning', 'removed-field', 'domains', 'domains were removed: providers are listed as they are, delete this mapping');
        else if (!TOP_LEVEL.has(key)) r.add('warning', 'unknown-field', key, 'unknown field');
    }
  }
  for (const group of [data.output, data.daemon, data.discovery] as Array<Record<string, number | undefined>>) {
    for (const key of Object.keys(group)) if (group[key] === undefined) delete group[key];
  }
  return { data, diagnostics: r.diagnostics };
}
