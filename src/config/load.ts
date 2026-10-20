// loadConfig: the single entry point of config/ (config.md). Reads framework configs (read-only),
// the user config and the project config, merges them and returns what the rest of via needs.
// Nothing here throws for a bad file: problems are collected in `diagnostics`.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { cwd as processCwd } from 'node:process';
import type { ConfigDiagnostic } from './diagnostics';
import { BUNDLED_FRAMEWORKS, DEFAULT_POINTERS, findFramework, type ConfigFormat, type FrameworkDef } from './frameworks';
import { validateLayer, type ConfigLayerData, type SourcesSetting } from './layer';
import { applyDef, canonical, newAccumulator, type Accumulator } from './merge';
import { isPlainObject, ownEntries, type OriginedDef, type ServerDef } from './model';
import { normalizeFrameworkEntry } from './normalize';
import { parseConfigText, resolvePointer, ParseFailure } from './parse';
import { expandPath, pathContext, resolveAgainst, userConfigPath, userDataDir, type Env, type PathContext } from './paths';
import { parseCredentialRef } from './credentials';
import { readTrustStore, trustStatus, type TrustStore } from './trust';
import type { ConfigOrigin, ConfigScope, ServerConfig, Transport } from './types';

export const DEFAULTS = {
  timeout: 60,
  concurrency: 4,
  confirm: 'destructive',
  output: { budget: 8192, cellWidth: 80 },
  daemon: { idleTimeout: 600, serverIdleTimeout: 300 },
} as const;

/** The project config file name; the first one found walking up from the working directory is used. */
export const PROJECT_CONFIG_NAME = '.via.yaml';

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
}

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
  domains: Record<string, string[]>;
  output: { budget: number; cellWidth: number };
  daemon: { idleTimeout: number; serverIdleTimeout: number };
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

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Nearest ancestor (starting at `from`) that contains `relative` as a file. */
function findUp(relative: string, from: string, ceiling?: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, relative);
    if (isFile(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || dir === ceiling) return undefined;
    dir = parent;
  }
}

interface ReadResult {
  bytes: Buffer;
  value: unknown;
}

async function readAndParse(path: string, format: ConfigFormat, severity: 'error' | 'warning', mandatory: boolean, diagnostics: ConfigDiagnostic[]): Promise<ReadResult | undefined> {
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
  try {
    return { bytes, value: await parseConfigText(bytes.toString('utf8'), format) };
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
  const cwd = resolve(options.cwd ?? processCwd());
  const frameworks = options.frameworks ?? BUNDLED_FRAMEWORKS;
  const diagnostics: ConfigDiagnostic[] = [];
  const files: LoadedFile[] = [];

  // 1. via's own configs, lowest priority first: user, project, CLI.
  const layers: Layer[] = [];
  const userPath = userConfigPath(ctx);
  const ceiling = options.projectRoot === undefined ? undefined : resolve(options.projectRoot);
  const projectPath = findUp(PROJECT_CONFIG_NAME, cwd, ceiling);
  for (const [scope, path] of [['user', userPath], ['project', projectPath]] as const) {
    if (path === undefined) continue;
    const read = await readAndParse(path, 'yaml', 'error', false, diagnostics);
    if (!read) continue;
    files.push({ path, scope, format: 'yaml', sha256: sha256(read.bytes) });
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
  const hashes = new Map(files.map((f) => [f.path, f.sha256]));
  const servers: ServerConfig[] = [];
  for (const [name, acc] of accumulators) {
    const server = finalize(name, acc, conflicts.get(name), trustStore, hashes, diagnostics);
    if (server) servers.push(server);
  }

  // 6. The rest of the config: deny, domains, output, daemon.
  const deny: RegExp[] = [];
  const seenDeny = new Set<string>();
  const domains: Record<string, string[]> = {};
  const output = { budget: DEFAULTS.output.budget, cellWidth: DEFAULTS.output.cellWidth };
  const daemon = { idleTimeout: DEFAULTS.daemon.idleTimeout, serverIdleTimeout: DEFAULTS.daemon.serverIdleTimeout };
  for (const layer of layers) {
    for (const [i, pattern] of layer.data.deny.entries()) {
      if (seenDeny.has(pattern)) continue;
      seenDeny.add(pattern);
      try {
        deny.push(new RegExp(pattern));
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
    for (const [domain, members] of ownEntries(layer.data.domains)) {
      Object.defineProperty(domains, domain, { value: members as string[], enumerable: true, writable: true, configurable: true });
    }
    Object.assign(output, layer.data.output);
    Object.assign(daemon, layer.data.daemon);
  }

  return { servers, deny, domains, output, daemon, diagnostics, files };
}

function finalize(
  name: string,
  acc: Accumulator,
  conflicts: ConfigOrigin[] | undefined,
  store: TrustStore,
  hashes: ReadonlyMap<string, string>,
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
    const hash = hashes.get(path);
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
  if (d.domain !== undefined) server.domain = d.domain;
  if (d.budget !== undefined) server.budget = d.budget;
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
    if (claimed.has(file.path)) return;
    claimed.add(file.path);
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
      else path = findUp(expanded, cwd, ceiling) ?? resolve(cwd, expanded);
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
      const loaded: LoadedFile = { path: source.path, scope: source.origin.scope, format: source.format, sha256: sha256(read.bytes) };
      if (source.origin.framework) loaded.framework = source.origin.framework;
      files.push(loaded);
      const map = findServerMap(read.value, source, diagnostics);
      if (!map) continue;
      for (const [name, entry] of ownEntries(map)) {
        const { def, diagnostics: found } = normalizeFrameworkEntry(name, entry, source.path, source.dollarVariables ? { dollarVariables: true } : {});
        diagnostics.push(...found);
        if (!def || !allowedHere(name, def, source.origin, diagnostics)) continue;
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
