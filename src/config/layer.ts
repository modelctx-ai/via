// Validation of via's own configuration (user `config.yaml`, project `.via.yaml`, CLI overrides)
// against the field reference in config.md. Problems are reported with their path, e.g.
// `servers.github.timeout: expected number`, and the offending field is left out.

import type { ConfigDiagnostic, DiagnosticCode, DiagnosticLevel } from './diagnostics';
import { isPlainObject, ownEntries, type ServerDef } from './model';
import { parseCredentialRef } from './credentials';
import type { AuthConfig, SemanticSearchConfig } from './types';

/** `sources` as written: `auto`, `false`, or a list of framework ids and file paths. */
export type SourcesSetting = 'auto' | false | string[];

/** The validated content of one via config file. Absent fields were not set. */
export interface ConfigLayerData {
  sources?: SourcesSetting;
  servers: Map<string, ServerDef>;
  deny: string[];
  domains: Record<string, string[]>;
  output: { budget?: number; cellWidth?: number };
  daemon: { idleTimeout?: number; serverIdleTimeout?: number };
  /** `search.semantic`: the validated fields, `false` to switch it off, absent when not set. */
  search: { semantic?: SemanticLayer | false };
}

/** The `search.semantic` fields as written (defaults are applied when the layers are merged). */
export type SemanticLayer = Pick<SemanticSearchConfig, 'url' | 'model' | 'auth'> &
  Partial<Pick<SemanticSearchConfig, 'timeout' | 'indexTimeout' | 'dimensions'>>;

const TOP_LEVEL = new Set(['sources', 'servers', 'deny', 'domains', 'output', 'daemon', 'search']);
const SERVER_FIELDS = new Set(['command', 'args', 'env', 'cwd', 'url', 'headers', 'auth', 'alias', 'domain', 'rename', 'disabled', 'exclusive', 'confirm', 'timeout', 'concurrency', 'budget', 'noise']);

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
        r.invalid(`${path}.oauth`, 'map with scopes and clientId', server);
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
        } else r.add('warning', 'unknown-field', `${path}.oauth.${k}`, 'unknown field', server);
      }
      return result;
    }
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
    if (!SERVER_FIELDS.has(key)) {
      r.add('warning', 'unknown-field', path, 'unknown field', name);
      continue;
    }
    switch (key) {
      case 'command': def.command = str(r, path, value, name); break;
      case 'cwd': def.cwd = str(r, path, value, name); break;
      case 'url': def.url = str(r, path, value, name); break;
      case 'alias': def.alias = str(r, path, value, name); break;
      case 'domain': def.domain = str(r, path, value, name); break;
      case 'args': def.args = strList(r, path, value, name, true); break;
      case 'noise': def.noise = strList(r, path, value, name); break;
      case 'env': def.env = strMap(r, path, value, name); break;
      case 'headers': def.headers = strMap(r, path, value, name); break;
      case 'rename': def.rename = strMap(r, path, value, name); break;
      case 'disabled': def.disabled = bool(r, path, value, name); break;
      case 'exclusive': def.exclusive = bool(r, path, value, name); break;
      case 'timeout': def.timeout = num(r, path, value, 'number', name); break;
      case 'concurrency': def.concurrency = num(r, path, value, 'integer', name); break;
      case 'budget': def.budget = num(r, path, value, 'integer', name); break;
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
  const data: ConfigLayerData = { servers: new Map(), deny: [], domains: {}, output: {}, daemon: {}, search: {} };
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
      case 'domains':
        if (!isPlainObject(value)) {
          r.invalid('domains', 'map of domain to list of providers');
          break;
        }
        for (const [domain, members] of ownEntries(value)) {
          const list = strList(r, `domains.${domain}`, members);
          if (list) Object.defineProperty(data.domains, domain, { value: list, enumerable: true, writable: true, configurable: true });
        }
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
      default:
        if (!TOP_LEVEL.has(key)) r.add('warning', 'unknown-field', key, 'unknown field');
    }
  }
  for (const group of [data.output, data.daemon] as Array<Record<string, number | undefined>>) {
    for (const key of Object.keys(group)) if (group[key] === undefined) delete group[key];
  }
  return { data, diagnostics: r.diagnostics };
}
