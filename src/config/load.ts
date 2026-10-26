// loadConfig: the single entry point of config/ (config.md). Reads framework configs (read-only),
// the user config and the project config, merges them and returns what the rest of via needs.
// Nothing here throws for a bad file: problems are collected in `diagnostics`.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { checkDenyPattern } from './deny-safety';
import type { ConfigDiagnostic } from './diagnostics';
import { BUNDLED_FRAMEWORKS, DEFAULT_POINTERS, findFramework, type ConfigFormat, type FrameworkDef } from './frameworks';
import { validateLayer, type ConfigLayerData, type SourcesSetting } from './layer';
import { applyDef, canonical, newAccumulator, type Accumulator } from './merge';
import { isPlainObject, ownEntries, type OriginedDef, type ServerDef } from './model';
import { normalizeFrameworkEntry } from './normalize';
import { findUp, PROJECT_CONFIG_NAME } from './policy-probe';
import { mergePolicy, type CommandPolicy, type Policy, type SandboxSettings } from './policy';
import { startsViaServe } from './self';
import { parseConfigText, resolvePointer, ParseFailure } from './parse';
import { ParseCache } from './parse-cache';
import { decodeText } from '../platform/text';
import { expandPath, pathContext, pathIdentity, resolveAgainst, userConfigPath, userDataDir, type Env, type PathContext } from './paths';
import { parseCredentialRef } from './credential-ref';
import { sha256Hex } from '../sha256';
import { readTrustStore, trustStatus, type TrustStore } from './trust';
import type { ConfigOrigin, ConfigScope, SemanticSearchConfig, ServerConfig, Transport } from './types';

export const DEFAULTS = {
  timeout: 60,
  concurrency: 4,
  confirm: 'destructive',
  output: { budget: 8192, cellWidth: 80 },
  daemon: { idleTimeout: 600, serverIdleTimeout: 300 },
  /** Seconds a discovery command (`via`, `via find`, `via prompt`) waits for one server when a daemon keeps connecting behind it. */
  discovery: { wait: 3 },
  semantic: { timeout: 3, indexTimeout: 30 },
} as const;

export { PROJECT_CONFIG_NAME };

export interface LoadConfigOptions {
  /** Working directory; project config and project-scoped framework configs are looked up from here. Default: process cwd. */
  cwd?: string;
  env?: Env;
  /** Home directory. Default: the current user's. */
  home?: string;
  platform?: NodeJS.Platform;
  /** Where the upward search for `.via.yaml` and project-scoped framework configs stops (inclusive). Default: the filesystem root. */
  projectRoot?: string;
  /** Overrides from the command line, in the shape of the config file (`{ servers: { x: { timeout: 5 } } }`). Validated like a file. */
  cliOverrides?: unknown;
  /** Where trust records live. Default: the user data directory. */
  dataDir?: string;
  /** Framework descriptions. Default: the bundled `data/frameworks/`. */
  frameworks?: readonly FrameworkDef[];
  /**
   * Directory that keeps the parsed form of YAML config files (parse-cache.ts). Default: none, so
   * a caller that does not ask never writes anything.
   */
  parseCacheDir?: string;
}

declare const __VIA_PARSE_ID__: string | undefined;

/** A config file that was read, with the hash of the exact bytes that were parsed. */
export interface LoadedFile {
  path: string;
  scope: ConfigScope;
  framework?: string;
  format: ConfigFormat;
  sha256: string;
}

export interface LoadedConfig {
  servers: ServerConfig[];
  /** Compiled `deny` patterns from user, project and CLI config, ready for the catalog. */
  deny: RegExp[];
  output: { budget: number; cellWidth: number };
  daemon: { idleTimeout: number; serverIdleTimeout: number };
  discovery: { wait: number };
  /** Optional features of `via find`; `semantic` is set only by the user config (security.md). */
  search?: { semantic?: SemanticSearchConfig };
  /** Which built-in subcommands may run and which are shown (ADR 0028). */
  commands: CommandPolicy;
  /** Whether via runs inside a sandbox program (ADR 0027); user config only. */
  sandbox: SandboxSettings;
  diagnostics: ConfigDiagnostic[];
  /** Every file that contributed, for `via doctor` and `via trust`. */
  files: LoadedFile[];
}

interface SourceFile {
  path: string;
  format: ConfigFormat;
  pointers: readonly string[];
  origin: ConfigOrigin;
  /** Report a missing file (an explicit source), instead of treating it as "framework not installed". */
  mandatory: boolean;
  /** From the framework's data file: a whole-value `$NAME` is an environment reference. */
  dollarVariables?: boolean;
}

interface Layer {
  origin: ConfigOrigin;
  data: ConfigLayerData;
}

/**
 * A `LoadedFile` whose `sha256` is computed on first read: only files that launch a process need
 * their hash (trust, `via doctor`), and hashing is not free on a cold start.
 */
function loadedFile(file: Omit<LoadedFile, 'sha256'>, read: ReadResult): LoadedFile {
  return Object.defineProperty(file, 'sha256', { enumerable: true, get: read.hash }) as LoadedFile;
}

interface ReadResult {
  bytes: Buffer;
  value: unknown;
  /** SHA-256 of `bytes`, computed on first use. */
  hash: () => string;
}

async function readAndParse(
  path: string,
  format: ConfigFormat,
  severity: 'error' | 'warning',
  mandatory: boolean,
  diagnostics: ConfigDiagnostic[],
  cache?: ParseCache,
): Promise<ReadResult | undefined> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      if (mandatory) diagnostics.push({ level: 'warning', code: 'file-missing', message: 'file does not exist', file: path });
    } else {
      diagnostics.push({ level: severity, code: 'file-unreadable', message: `cannot read file: ${code ?? 'read error'}`, file: path });
    }
    return undefined;
  }
  let digest: string | undefined;
  const hash = (): string => (digest ??= sha256Hex(bytes));
  try {
    return { bytes, hash, value: await parseConfigText(decodeText(bytes), format, { ...(cache ? { cache } : {}), key: hash }) };
  } catch (error) {
    const message = error instanceof ParseFailure ? error.message : 'could not be parsed';
    diagnostics.push({ level: severity, code: 'file-malformed', message, file: path });
    return undefined;
  }
}

/** `cmd:` references are only allowed in the user config (security.md); returns the offending field. */
function findCmdRef(def: ServerDef): string | undefined {
  const isCmd = (v: string): boolean => parseCredentialRef(v).kind === 'cmd';
  for (const [k, v] of Object.entries(def.env ?? {})) if (isCmd(v)) return `env.${k}`;
  for (const [k, v] of Object.entries(def.headers ?? {})) if (isCmd(v)) return `headers.${k}`;
  if (def.auth?.type === 'bearer' && isCmd(def.auth.bearer)) return 'auth.bearer';
  if (def.auth?.type === 'oauth') {
    if (def.auth.clientSecret !== undefined && isCmd(def.auth.clientSecret)) return 'auth.oauth.clientSecret';
    if (def.auth.privateKey !== undefined && isCmd(def.auth.privateKey)) return 'auth.oauth.privateKey';
  }
  if (def.auth?.type === 'headers') {
    for (const [k, v] of Object.entries(def.auth.headers)) if (isCmd(v)) return `auth.headers.${k}`;
  }
  return undefined;
}

/** Reject a definition holding a `cmd:` reference unless it comes from the user config or the CLI. */
function allowedHere(name: string, def: ServerDef, origin: ConfigOrigin, diagnostics: ConfigDiagnostic[]): boolean {
  if (origin.scope === 'user' || origin.scope === 'cli') return true;
  const field = findCmdRef(def);
  if (field === undefined) return true;
  const diagnostic: ConfigDiagnostic = {
    level: 'error',
    code: 'cmd-forbidden',
    message: `servers.${name}.${field}: cmd: credential references are only allowed in the user config; this server definition was ignored`,
    server: name,
  };
  if (origin.path) diagnostic.file = origin.path;
  diagnostics.push(diagnostic);
  return false;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const ctx: PathContext = pathContext(options);
  const cwd = resolve(options.cwd ?? process.cwd());
  const frameworks = options.frameworks ?? BUNDLED_FRAMEWORKS;
  const diagnostics: ConfigDiagnostic[] = [];
  const files: LoadedFile[] = [];
  const parseCache = options.parseCacheDir === undefined ? undefined : new ParseCache(options.parseCacheDir, typeof __VIA_PARSE_ID__ === 'string' ? __VIA_PARSE_ID__ : 'source');

  // 1. via's own configs, lowest priority first: user, project, CLI.
  const layers: Layer[] = [];
  const userPath = userConfigPath(ctx);
  const ceiling = options.projectRoot === undefined ? undefined : resolve(options.projectRoot);
  const projectPath = findUp(PROJECT_CONFIG_NAME, cwd, ceiling, ctx.platform);
  for (const [scope, path] of [['user', userPath], ['project', projectPath]] as const) {
    if (path === undefined) continue;
    const read = await readAndParse(path, 'yaml', 'error', false, diagnostics, parseCache);
    if (!read) continue;
    files.push(loadedFile({ path, scope, format: 'yaml' }, read));
    const { data, diagnostics: found } = validateLayer(read.value, path);
    diagnostics.push(...found);
    layers.push({ origin: { scope, path }, data });
  }
  if (options.cliOverrides !== undefined) {
    const { data, diagnostics: found } = validateLayer(options.cliOverrides, undefined);
    diagnostics.push(...found);
    layers.push({ origin: { scope: 'cli' }, data });
  }

  // 2. Which framework configs to read: the highest-priority layer that sets `sources` decides.
  let sources: SourcesSetting = 'auto';
  let sourcesLayer: Layer | undefined;
  for (const layer of layers) {
    if (layer.data.sources !== undefined) {
      sources = layer.data.sources;
      sourcesLayer = layer;
    }
  }
  const sourceFiles = resolveSources(sources, sourcesLayer, frameworks, ctx, cwd, ceiling, diagnostics);

  // 3. Framework configs (read-only), first source wins.
  const frameworkDefs = await readFrameworks(sourceFiles, diagnostics, files);

  // 4. Merge: framework definitions, then via's layers.
  const accumulators = new Map<string, Accumulator>();
  const conflicts = new Map<string, ConfigOrigin[]>();
  for (const [name, { def, origin }] of frameworkDefs.winners) {
    const acc = newAccumulator();
    applyDef(acc, def, origin);
    accumulators.set(name, acc);
  }
  for (const [name, list] of frameworkDefs.conflicts) conflicts.set(name, list);
  for (const layer of layers) {
    for (const [name, def] of layer.data.servers) {
      if (!allowedHere(name, def, layer.origin, diagnostics)) continue;
      let acc = accumulators.get(name);
      if (!acc) {
        acc = newAccumulator();
        accumulators.set(name, acc);
      }
      applyDef(acc, def, layer.origin);
    }
  }

  // 5. Trust, then the final ServerConfig values.
  const dataDir = options.dataDir ?? userDataDir(ctx);
  const needsTrust = [...accumulators.values()].some((acc) => acc.launch.size > 0);
  let trustStore: TrustStore = { version: 1, entries: {} };
  if (needsTrust) {
    const { store, error } = readTrustStore(dataDir);
    trustStore = store;
    if (error) diagnostics.push({ level: 'warning', code: 'trust-store-corrupt', message: error });
  }
  // Looked up only for files that launch a process (the hash is computed on demand).
  const hashOf = (path: string): string | undefined => files.find((f) => f.path === path)?.sha256;
  const servers: ServerConfig[] = [];
  for (const [name, acc] of accumulators) {
    const server = finalize(name, acc, conflicts.get(name), trustStore, hashOf, diagnostics);
    if (server) servers.push(server);
  }

  // 6. The rest of the config: deny, output, daemon.
  const deny: RegExp[] = [];
  const seenDeny = new Set<string>();
  const output = { budget: DEFAULTS.output.budget, cellWidth: DEFAULTS.output.cellWidth };
  const daemon = { idleTimeout: DEFAULTS.daemon.idleTimeout, serverIdleTimeout: DEFAULTS.daemon.serverIdleTimeout };
  const discovery = { wait: DEFAULTS.discovery.wait };
  const search: LoadedConfig['search'] = {};
  for (const layer of layers) {
    for (const [i, pattern] of layer.data.deny.entries()) {
      if (seenDeny.has(pattern)) continue;
      seenDeny.add(pattern);
      try {
        const re = new RegExp(pattern);
        // A rule that can backtrack catastrophically is refused like an invalid one (fail closed:
        // the diagnostic is an error, so the CLI stops instead of running without the rule).
        const unsafe = checkDenyPattern(pattern);
        if (unsafe !== undefined) {
          const d: ConfigDiagnostic = {
            level: 'error',
            code: 'unsafe-deny',
            message: `deny[${i}]: regular expression ${JSON.stringify(pattern.length > 80 ? `${pattern.slice(0, 77)}...` : pattern)} was refused: ${unsafe}; the rule was ignored`,
          };
          if (layer.origin.path) d.file = layer.origin.path;
          diagnostics.push(d);
          continue;
        }
        deny.push(re);
      } catch (error) {
        const d: ConfigDiagnostic = {
          level: 'error',
          code: 'invalid-deny',
          message: `deny[${i}]: invalid regular expression ${JSON.stringify(pattern)} (${error instanceof Error ? error.message.replace(/^Invalid regular expression: /, '') : 'syntax error'}); the rule was ignored`,
        };
        if (layer.origin.path) d.file = layer.origin.path;
        diagnostics.push(d);
      }
    }
    Object.assign(output, layer.data.output);
    Object.assign(daemon, layer.data.daemon);
    Object.assign(discovery, layer.data.discovery);
    const wanted = layer.data.search.semantic;
    if (wanted !== undefined) {
      if (layer.origin.scope !== 'user' && layer.origin.scope !== 'cli') {
        // It would send tool descriptions and queries to a host chosen by the repository.
        const d: ConfigDiagnostic = {
          level: 'warning',
          code: 'search-forbidden',
          message: 'search.semantic is only read from the user config; it was ignored',
        };
        if (layer.origin.path) d.file = layer.origin.path;
        diagnostics.push(d);
      } else if (wanted === false) delete search.semantic;
      else search.semantic = { provider: 'openai-compatible', ...DEFAULTS.semantic, ...wanted, origin: layer.origin };
    }
  }

  const merged = mergePolicy(layers, ctx, cwd);
  diagnostics.push(...merged.diagnostics);

  return { servers, deny, output, daemon, discovery, search, commands: merged.policy.commands, sandbox: merged.policy.sandbox, diagnostics, files };
}

/** Diagnostics of the `commands` and `sandbox` fields (their messages start with the field path). */
const POLICY_FIELD = /^(?:commands|sandbox)\b/;

/**
 * Only `commands` and `sandbox`, read before a command is dispatched (run.ts). `files` are the user
 * and project config files that mention either key (policy-probe.ts); the rest of the configuration
 * is left to `loadConfig`, which the command loads if it needs it. Errors in these fields, and a
 * file that cannot be parsed, are returned as error-level diagnostics so the caller can stop
 * (fail closed: a `commands.deny` that was not read must not leave the command runnable).
 */
export async function loadPolicy(files: readonly string[], options: LoadConfigOptions = {}): Promise<{ policy: Policy; diagnostics: ConfigDiagnostic[] }> {
  const ctx: PathContext = pathContext(options);
  const cwd = resolve(options.cwd ?? process.cwd());
  const parseCache = options.parseCacheDir === undefined ? undefined : new ParseCache(options.parseCacheDir, typeof __VIA_PARSE_ID__ === 'string' ? __VIA_PARSE_ID__ : 'source');
  const userPath = userConfigPath(ctx);
  const diagnostics: ConfigDiagnostic[] = [];
  const layers: Layer[] = [];
  // The user config first: lower priority than the project's.
  const ordered = [...files].sort((a, b) => Number(b === userPath) - Number(a === userPath));
  for (const path of ordered) {
    const read = await readAndParse(path, 'yaml', 'error', false, diagnostics, parseCache);
    if (!read) continue;
    const { data, diagnostics: found } = validateLayer(read.value, path);
    diagnostics.push(...found.filter((d) => POLICY_FIELD.test(d.message)));
    layers.push({ origin: { scope: path === userPath ? 'user' : 'project', path }, data });
  }
  const merged = mergePolicy(layers, ctx, cwd);
  diagnostics.push(...merged.diagnostics);
  return { policy: merged.policy, diagnostics };
}

function finalize(
  name: string,
  acc: Accumulator,
  conflicts: ConfigOrigin[] | undefined,
  store: TrustStore,
  hashOf: (path: string) => string | undefined,
  diagnostics: ConfigDiagnostic[],
): ServerConfig | undefined {
  const d = acc.def;
  let transport: Transport;
  let trusted = true;
  let untrustedPaths: string[] | undefined;
  if (d.command !== undefined) {
    transport = { type: 'stdio', command: d.command, args: d.args ?? [], env: d.env ?? {} };
    if (d.cwd !== undefined) transport.cwd = d.cwd;
  } else if (d.url !== undefined) {
    transport = { type: 'http', url: d.url, headers: d.headers ?? {} };
  } else {
    diagnostics.push({
      level: 'warning',
      code: 'server-undefined',
      message: `servers.${name}: has settings but no command or url, and no framework source defines it; ignored`,
      server: name,
    });
    return undefined;
  }
  const pending: string[] = [];
  for (const path of acc.launch.keys()) {
    const hash = hashOf(path);
    if (hash === undefined || trustStatus(store, path, hash) !== 'trusted') pending.push(path);
  }
  if (pending.length > 0) {
    trusted = false;
    untrustedPaths = pending;
  }
  const server: ServerConfig = {
    name,
    provider: d.alias ?? name,
    transport,
    auth: d.auth ?? { type: 'none' },
    rename: d.rename ?? {},
    disabled: d.disabled ?? false,
    exclusive: d.exclusive ?? false,
    confirm: d.confirm ?? DEFAULTS.confirm,
    timeout: d.timeout ?? DEFAULTS.timeout,
    concurrency: d.concurrency ?? DEFAULTS.concurrency,
    noise: d.noise ?? [],
    origin: acc.transportOrigin ?? { scope: 'cli' },
    trusted,
  };
  if (d.budget !== undefined) server.budget = d.budget;
  if (d.protocolVersion !== undefined) server.protocolVersion = d.protocolVersion;
  if (d.roots !== undefined && d.roots.length > 0) {
    server.roots = [...d.roots];
    if (transport.type === 'http') {
      diagnostics.push({
        level: 'warning',
        code: 'roots-remote',
        message: `servers.${name}.roots: local directories are sent to the remote server ${name} when it asks for its roots`,
        server: name,
      });
    }
  }
  if (conflicts && conflicts.length > 0) server.conflicts = conflicts;
  if (acc.launch.size > 0) server.launchPaths = [...acc.launch.keys()];
  if (untrustedPaths) server.untrustedPaths = untrustedPaths;
  return server;
}

// Sources ------------------------------------------------------------------------------------

function resolveSources(
  sources: SourcesSetting,
  layer: Layer | undefined,
  frameworks: readonly FrameworkDef[],
  ctx: PathContext,
  cwd: string,
  ceiling: string | undefined,
  diagnostics: ConfigDiagnostic[],
): SourceFile[][] {
  if (sources === false) return [];
  const out: SourceFile[][] = [];
  const claimed = new Set<string>();
  const add = (list: SourceFile[], file: SourceFile): void => {
    const identity = pathIdentity(file.path, ctx.platform);
    if (claimed.has(identity)) return;
    claimed.add(identity);
    list.push(file);
  };

  const frameworkFiles = (framework: FrameworkDef, mandatory: boolean): SourceFile[] => {
    const list: SourceFile[] = [];
    // User-scoped files claim their paths first, so a project walk-up that lands on one is not read twice.
    const ordered = [...framework.configs].sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'user' ? -1 : 1));
    for (const config of ordered) {
      if (config.platforms && !config.platforms.includes(ctx.platform)) continue;
      const expanded = expandPath(config.path, ctx);
      if (expanded === undefined) continue;
      let path: string | undefined;
      if (config.scope === 'user' || isAbsolute(expanded)) path = resolve(expanded);
      else path = findUp(expanded, cwd, ceiling, ctx.platform) ?? resolve(cwd, expanded);
      add(list, {
        path,
        format: config.format,
        pointers: [config.pointer],
        origin: { scope: config.scope === 'user' ? 'framework-user' : 'framework-project', path, framework: framework.id },
        mandatory: mandatory && config.scope === 'user',
        ...(config.dollarVariables ? { dollarVariables: true } : {}),
      });
    }
    return list;
  };

  if (sources === 'auto') {
    for (const framework of frameworks) out.push(frameworkFiles(framework, false));
    return out;
  }

  const base = layer?.origin.path ? dirname(layer.origin.path) : cwd;
  const scope: ConfigScope = layer?.origin.scope === 'project' ? 'framework-project' : 'framework-user';
  for (const item of sources) {
    const framework = findFramework(item, frameworks);
    if (framework) {
      out.push(frameworkFiles(framework, true));
      continue;
    }
    if (!/[./\\~]/.test(item)) {
      diagnostics.push({
        level: 'warning',
        code: 'unknown-source',
        message: `sources: "${item}" is not a known framework id (${frameworks.map((f) => f.id).join(', ')}); file paths must contain a "/" or an extension`,
        ...(layer?.origin.path ? { file: layer.origin.path } : {}),
      });
      continue;
    }
    const path = resolveAgainst(item, base, ctx);
    const list: SourceFile[] = [];
    add(list, { path, format: formatOf(path), pointers: DEFAULT_POINTERS, origin: { scope, path }, mandatory: true });
    out.push(list);
  }
  return out;
}

function formatOf(path: string): ConfigFormat {
  const lower = path.toLowerCase();
  if (lower.endsWith('.toml')) return 'toml';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.jsonc')) return 'jsonc';
  return 'json';
}

async function readFrameworks(
  groups: readonly SourceFile[][],
  diagnostics: ConfigDiagnostic[],
  files: LoadedFile[],
): Promise<{ winners: Map<string, OriginedDef>; conflicts: Map<string, ConfigOrigin[]> }> {
  const winners = new Map<string, OriginedDef>();
  const conflicts = new Map<string, ConfigOrigin[]>();

  for (const group of groups) {
    // Within one framework a project file overrides the user file (users first, then projects).
    const own = new Map<string, OriginedDef>();
    // A framework may list alternative spellings of one file (`settings.json` / `settings.jsonc`);
    // an explicit source reports missing files only when none of the group's files exists.
    const missing: ConfigDiagnostic[] = [];
    let anyRead = false;
    for (const source of group) {
      const read = await readAndParse(source.path, source.format, 'warning', false, diagnostics);
      if (!read) {
        if (source.mandatory && !existsSync(source.path)) missing.push({ level: 'warning', code: 'file-missing', message: 'file does not exist', file: source.path });
        continue;
      }
      anyRead = true;
      const meta: Omit<LoadedFile, 'sha256'> = { path: source.path, scope: source.origin.scope, format: source.format };
      if (source.origin.framework) meta.framework = source.origin.framework;
      files.push(loadedFile(meta, read));
      const map = findServerMap(read.value, source, diagnostics);
      if (!map) continue;
      for (const [name, entry] of ownEntries(map)) {
        const { def, diagnostics: found } = normalizeFrameworkEntry(name, entry, source.path, source.dollarVariables ? { dollarVariables: true } : {});
        diagnostics.push(...found);
        if (!def || !allowedHere(name, def, source.origin, diagnostics)) continue;
        if (startsViaServe(def)) {
          diagnostics.push({ level: 'info', code: 'self-reference', message: `servers.${name}: runs via serve, which is via itself; left out of the catalog`, file: source.path, server: name });
          continue;
        }
        if (own.get(name)?.origin.scope === source.origin.scope) continue;
        own.set(name, { def, origin: source.origin });
      }
    }
    if (!anyRead) diagnostics.push(...missing);
    for (const [name, candidate] of own) {
      const winner = winners.get(name);
      if (!winner) {
        winners.set(name, candidate);
      } else if (canonical(winner.def) !== canonical(candidate.def)) {
        const list = conflicts.get(name) ?? [];
        list.push(candidate.origin);
        conflicts.set(name, list);
      }
    }
  }
  return { winners, conflicts };
}

function findServerMap(doc: unknown, source: SourceFile, diagnostics: ConfigDiagnostic[]): Record<string, unknown> | undefined {
  for (const pointer of source.pointers) {
    const found = resolvePointer(doc, pointer);
    if (!found.found) continue;
    if (isPlainObject(found.value)) return found.value;
    diagnostics.push({ level: 'warning', code: 'file-malformed', message: `${pointer} is not a map of servers`, file: source.path });
    return undefined;
  }
  if (source.mandatory) {
    diagnostics.push({ level: 'warning', code: 'file-malformed', message: `no server map found at ${source.pointers.join(' or ')}`, file: source.path });
  }
  return undefined;
}
