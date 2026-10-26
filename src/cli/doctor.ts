// `via doctor` (guides/agent-integration.md): connection and auth status per server, frameworks
// still injecting MCP schemas with their disable hints, plaintext secrets, config problems.
// Pure: the CLI probes the servers and prints the text; nothing here reads files or the network.
import { formatDiagnostic, isCredentialRef, type ConfigDiagnostic, type FrameworkDef, type LoadedConfig, type ServerConfig } from '../config';
import type { CatalogWarning } from '../catalog';
import type { ProtocolInfo } from '../protocol';
import { protocolLabel } from './protocol-label';
import { askToRun } from '../render/ask';
import { ExitCode } from '../render/exit-codes';
import { shortenHome } from '../config/paths';
import { shellArg, shellWord } from '../render/shell';
import { displayWidth, padEndWidth, truncateChars } from '../render/width';
import type { HostKind } from '../platform/host';

/** Result of probing one server (done by the CLI with the client; doctor only renders). */
export interface ServerProbe {
  /** Key under `servers`. */
  server: string;
  provider: string;
  status: 'ok' | 'needs-auth' | 'error' | 'untrusted' | 'disabled';
  /** Short reason for non-ok statuses, already redacted. */
  message?: string;
  /** Suggested fix for the `next:` line (e.g. `CredentialError.next`), already redacted. Overrides the derived one. */
  next?: string;
  toolCount?: number;
  /** What the connection negotiated (cli.md, `via doctor`); absent when the list came from a source that does not know. */
  protocol?: ProtocolInfo;
  /** Something to fix that does not stop the server from working (e.g. an unwritable OAuth login store). */
  warning?: { message: string; next?: string };
  /** Length of the serialized `tools/list` result, for the tokens/turn estimate. */
  schemaBytes?: number;
}

export interface DoctorInput {
  config: LoadedConfig;
  frameworks: readonly FrameworkDef[];
  probes: readonly ServerProbe[];
  /** Catalog warnings (reserved names, duplicate providers) to surface. */
  catalogWarnings?: readonly CatalogWarning[];
  /** Home directory; paths below it are shown as `~/…`. */
  home?: string;
  /**
   * The effective HTTP proxy, one line per part, userinfo already hidden (`describeProxy`); empty when none
   * is set. Absent: not reported (config.md, "代理").
   */
  proxy?: readonly string[];
  /**
   * Where the logs are (daemon.md, "日志") and how much they take; `files` and `bytes` are absent when the
   * directory does not exist yet. Absent: not reported.
   */
  logs?: { dir: string; files?: number; bytes?: number };
  /**
   * The kind of machine (guides/getting-started.md, "Windows") and, under WSL, the framework configs
   * read from the Windows side (`/mnt/<drive>/…`). Rendered as a `platform` line only when there is
   * something to say; absent: not reported.
   */
  host?: { kind: HostKind; windowsSideFiles?: readonly string[] };
  /** Whether this `via doctor` runs inside the sandbox (ADR 0027); the line is shown only when `sandbox.enabled`. */
  sandboxed?: boolean;
}

export interface DoctorOutput {
  text: string;
  /**
   * 0 when everything is usable. Otherwise the highest applicable code (output.md):
   * 6 a server failed to connect, 5 a server awaits `via trust`, 4 a server needs auth,
   * 2 the config has error-level diagnostics. Warnings (plaintext secrets, frameworks still
   * injecting schemas, warning-level diagnostics) never change the exit code.
   */
  exitCode: number;
}

/** A serialized `tools/list` costs about one token per this many bytes (rough, for English JSON). */
export const BYTES_PER_TOKEN = 4;

/** Config keys (`env` names, header names) whose literal values are reported as plaintext secrets. */
export const SECRET_KEY_PATTERN = /KEY|TOKEN|SECRET|PASSW(?:OR)?D|AUTH|CREDENTIAL/i;

const MESSAGE_MAX = 200;

type Status = ServerProbe['status'];

const STATUS_LABEL: Record<Exclude<Status, 'ok'>, string> = {
  'needs-auth': 'needs auth',
  error: 'failed',
  untrusted: 'untrusted',
  disabled: 'disabled',
};

const STATUS_EXIT: Record<Status, number> = {
  ok: ExitCode.Ok,
  disabled: ExitCode.Ok,
  'needs-auth': ExitCode.Auth,
  untrusted: ExitCode.Denied,
  error: ExitCode.Upstream,
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function oneLine(text: string): string {
  return truncateChars(text.replace(/\s+/g, ' ').trim(), MESSAGE_MAX);
}

const shorten = (path: string, home: string | undefined): string => shortenHome(path, home);

/** `shorten` for paths inside a sentence. */
function shortenIn(text: string, home: string | undefined): string {
  if (!home) return text;
  const base = home.replace(/[\\/]+$/, '');
  return text.split(`${base}/`).join('~/');
}

// servers ------------------------------------------------------------------------------------

interface Row {
  server: string;
  provider: string;
  status: Status;
  message?: string;
  next?: string;
  warning?: { message: string; next?: string };
  protocol?: ProtocolInfo;
}

/** Probes, plus config servers nobody probed that are known to be unusable (untrusted, disabled). */
function collectRows(input: DoctorInput): Row[] {
  const byName = new Map(input.config.servers.map((s) => [s.name, s]));
  const rows: Row[] = input.probes.map((p) => {
    const row: Row = { server: p.server, provider: p.provider, status: p.status };
    if (p.message) row.message = oneLine(p.message);
    if (p.next) row.next = oneLine(p.next);
    if (p.protocol) row.protocol = p.protocol;
    if (p.warning) row.warning = { message: oneLine(p.warning.message), ...(p.warning.next ? { next: oneLine(p.warning.next) } : {}) };
    return row;
  });
  const probed = new Set(input.probes.map((p) => p.server));
  for (const s of input.config.servers) {
    if (probed.has(s.name)) continue;
    if (s.disabled) rows.push({ server: s.name, provider: s.provider, status: 'disabled' });
    else if (!s.trusted) rows.push({ server: s.name, provider: s.provider, status: 'untrusted' });
  }
  return rows.map((row) => {
    if (row.next || row.status === 'ok' || row.status === 'disabled') return row;
    const next = defaultNext(row, byName.get(row.server));
    return next.length > 0 ? { ...row, next: next.join('\n') } : row;
  });
}

/** Obvious fixes: log in for OAuth servers, `via trust <file>` for untrusted project files. */
function defaultNext(row: Row, server: ServerConfig | undefined): string[] {
  if (row.status === 'needs-auth' && server?.auth.type === 'oauth') return [askToRun(`via auth login ${shellArg(row.provider, { placeholder: 'provider', positional: true })}`)];
  if (row.status === 'untrusted') {
    const paths = server?.untrustedPaths ?? [];
    return paths.length > 0 ? paths.map((p) => askToRun(`via trust ${shellWord(p)}`)) : [askToRun('via trust')];
  }
  return [];
}

function renderServers(rows: readonly Row[], home: string | undefined, pins: ReadonlyMap<string, string>): string[] {
  if (rows.length === 0) return ['servers   none configured'];
  const parts: string[] = [`${rows.filter((r) => r.status === 'ok').length} ok`];
  for (const status of ['needs-auth', 'error', 'untrusted', 'disabled'] as const) {
    const names = rows.filter((r) => r.status === status).map((r) => r.provider);
    if (names.length > 0) parts.push(`${names.length} ${STATUS_LABEL[status]} (${names.join(', ')})`);
  }
  const lines = [`servers   ${parts.join(' · ')}`];
  for (const row of rows) {
    if (row.status === 'ok') {
      const label = protocolLabel(row.protocol, pins.get(row.server));
      if (label) lines.push(`  ${row.provider}: MCP ${label}`);
    }
    if (row.status !== 'ok' && row.status !== 'disabled') {
      lines.push(`  ${row.provider}: ${STATUS_LABEL[row.status]}${row.message ? ` (${row.message})` : ''}`);
      for (const next of row.next?.split('\n') ?? []) lines.push(`    next: ${shorten(next, home)}`);
    }
    if (row.warning) {
      lines.push(`  ${row.provider}: warning: ${shortenIn(row.warning.message, home)}`);
      if (row.warning.next) lines.push(`    next: ${shortenIn(row.warning.next, home)}`);
    }
  }
  return lines;
}

// proxy --------------------------------------------------------------------------------------

function renderProxy(lines: readonly string[]): string[] {
  if (lines.length === 0) return ['proxy     none'];
  return lines.map((line, i) => `${i === 0 ? 'proxy     ' : '          '}${line}`);
}

// logs ---------------------------------------------------------------------------------------

/** 812 -> `812 B`, 49152 -> `48 KiB`, 1258291 -> `1.2 MiB`. */
function formatLogSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function renderLogs(logs: NonNullable<DoctorInput['logs']>, home: string | undefined): string[] {
  const where = shorten(logs.dir, home);
  if (logs.files === undefined || logs.bytes === undefined) return [`logs      ${where} (none yet)`];
  return [`logs      ${where} (${logs.files} ${logs.files === 1 ? 'file' : 'files'}, ${formatLogSize(logs.bytes)})`];
}

// platform -----------------------------------------------------------------------------------

/** Where the Windows notes live; the hints point there instead of repeating them. */
const WINDOWS_GUIDE = 'docs/guides/getting-started.md#windows';
/** How many Windows-side files the `platform` line lists before counting the rest. */
const WINDOWS_SIDE_FILES_SHOWN = 3;

/**
 * One `platform` line, only when the machine has a known pitfall for agents (getting-started.md,
 * "Windows"): on Windows the quoting of PowerShell 5.1 and cmd.exe, under WSL framework configs read
 * across `/mnt`. Hints only; the exit code is unaffected. Nothing on other hosts, so the output of
 * macOS and Linux users stays as it was.
 */
function renderPlatform(host: NonNullable<DoctorInput['host']>, home: string | undefined): string[] {
  if (host.kind === 'windows') {
    return [
      `platform  windows · PowerShell 5.1 drops the inner quotes of --args '{…}' and cmd.exe does not group with single quotes; pass JSON as --args @file, or use PowerShell 7.3+ (${WINDOWS_GUIDE})`,
    ];
  }
  const files = host.windowsSideFiles ?? [];
  if (host.kind !== 'wsl' || files.length === 0) return [];
  const lines = [
    `platform  wsl · ${plural(files.length, 'config file')} read from the Windows side; reads across /mnt are slow, keep the agent, via and their configs inside WSL (${WINDOWS_GUIDE})`,
  ];
  for (const file of files.slice(0, WINDOWS_SIDE_FILES_SHOWN)) lines.push(`          ${shorten(file, home)}`);
  const rest = files.length - WINDOWS_SIDE_FILES_SHOWN;
  if (rest > 0) lines.push(`          … ${rest} more`);
  return lines;
}

// sandbox and commands -----------------------------------------------------------------------

/** A `sandbox` line when it is on (ADR 0027): which program, and whether this check itself ran inside it. */
function renderSandbox(input: DoctorInput): string[] {
  const { sandbox } = input.config;
  if (!sandbox.enabled) return [];
  const where = input.sandboxed ? 'this check ran inside it' : 'via doctor ran outside it (sandbox.exclude), so the checks above did too';
  const policy = sandbox.policy === undefined ? 'its own default settings' : 'file' in sandbox.policy ? shorten(sandbox.policy.file, input.home) : 'the settings in sandbox.policy';
  return [`sandbox   ${sandbox.command.join(' ')} · ${policy} · ${where}`];
}

/** A `commands` line when the config restricts any (ADR 0028). */
function renderCommands(input: DoctorInput): string[] {
  const { commands } = input.config;
  const parts: string[] = [];
  if (commands.allow !== undefined) parts.push(`allow: ${[...commands.allow].join(', ') || '(none)'}`);
  if (commands.deny.size > 0) parts.push(`deny: ${[...commands.deny].join(', ')}`);
  if (commands.show !== undefined) parts.push(`show: ${[...commands.show].join(', ') || '(none)'}`);
  if (commands.hide.size > 0) parts.push(`hide: ${[...commands.hide].join(', ')}`);
  return parts.length === 0 ? [] : [`commands  ${parts.join(' · ')}`];
}

/** The `proxy`, `logs`, `platform`, `sandbox` and `commands` lines share one section: they say where via runs and where its traffic and records go. */
function environment(input: DoctorInput): string[][] {
  const lines = [
    ...(input.proxy ? renderProxy(input.proxy) : []),
    ...(input.logs ? renderLogs(input.logs, input.home) : []),
    ...(input.host ? renderPlatform(input.host, input.home) : []),
    ...renderSandbox(input),
    ...renderCommands(input),
  ];
  return lines.length > 0 ? [lines] : [];
}

// frameworks ---------------------------------------------------------------------------------

function formatTokens(bytes: number): string {
  const tokens = Math.round(bytes / BYTES_PER_TOKEN);
  if (tokens < 1000) return `~${tokens} tokens/turn`;
  const k = tokens / 1000;
  return `~${k < 10 ? (Math.round(k * 10) / 10).toString() : Math.round(k).toString()}k tokens/turn`;
}

/** Framework id → names of the servers it defines (including ignored conflicting definitions). */
function frameworkServers(servers: readonly ServerConfig[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (framework: string | undefined, name: string): void => {
    if (!framework) return;
    const set = out.get(framework) ?? new Set<string>();
    set.add(name);
    out.set(framework, set);
  };
  for (const s of servers) {
    add(s.origin.framework, s.name);
    for (const c of s.conflicts ?? []) add(c.framework, s.name);
  }
  return out;
}

function renderFrameworks(input: DoctorInput): string[] {
  const members = frameworkServers(input.config.servers);
  if (members.size === 0) return ['frameworks: no MCP servers found in framework configs'];
  const bytesOf = new Map(input.probes.filter((p) => p.schemaBytes !== undefined).map((p) => [p.server, p.schemaBytes!]));
  const known = input.frameworks.map((f) => f.id);
  const ids = [...known.filter((id) => members.has(id)), ...[...members.keys()].filter((id) => !known.includes(id)).sort()];
  const width = Math.max(...ids.map((id) => displayWidth(id)));
  const lines = ['frameworks still injecting MCP schemas:'];
  for (const id of ids) {
    const names = [...members.get(id)!];
    const measured = names.filter((n) => bytesOf.has(n));
    const size = measured.length === 0 ? 'size unknown' : formatTokens(measured.reduce((n, name) => n + bytesOf.get(name)!, 0));
    lines.push(`  ${padEndWidth(id, width)}   ${plural(names.length, 'server')} · ${size}`);
    const hint = input.frameworks.find((f) => f.id === id)?.disableHint;
    if (hint) lines.push(`    hint: ${hint}`);
  }
  return lines;
}

// secrets ------------------------------------------------------------------------------------

interface Secret {
  server: string;
  /** Config path below the server, e.g. `env.EXA_API_KEY`, `auth.bearer`. */
  field: string;
  file?: string;
}

function isPlaintext(key: string, value: string): boolean {
  return value !== '' && !isCredentialRef(value) && SECRET_KEY_PATTERN.test(key);
}

/** `servers.github.auth.bearer: is a literal…` → `auth.bearer`. */
function diagnosticField(d: ConfigDiagnostic): string | undefined {
  const path = d.message.split(': ')[0] ?? '';
  const prefix = `servers.${d.server}.`;
  return d.server !== undefined && path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

function findSecrets(config: LoadedConfig): Secret[] {
  const found = new Map<string, Secret>();
  const add = (secret: Secret): void => {
    found.set(`${secret.server}\0${secret.field}\0${secret.file ?? ''}`, secret);
  };
  // auth literals: the loader already knows the exact file.
  const authReported = new Set<string>();
  for (const d of config.diagnostics) {
    if (d.code !== 'plaintext-credential') continue;
    const field = diagnosticField(d);
    if (field === undefined || d.server === undefined) continue;
    authReported.add(`${d.server}\0${field}`);
    add({ server: d.server, field, ...(d.file ? { file: d.file } : {}) });
  }
  for (const s of config.servers) {
    const where = s.origin.path ? { file: s.origin.path } : {};
    const values = s.transport.type === 'stdio' ? ['env', s.transport.env] as const : ['headers', s.transport.headers] as const;
    for (const [key, value] of Object.entries(values[1])) {
      if (isPlaintext(key, value)) add({ server: s.name, field: `${values[0]}.${key}`, ...where });
    }
    // Backstop for auth literals the loader did not report (every literal there is a secret).
    if (s.auth.type === 'bearer' && !isCredentialRef(s.auth.bearer) && !authReported.has(`${s.name}\0auth.bearer`)) {
      add({ server: s.name, field: 'auth.bearer' });
    }
    if (s.auth.type === 'headers') {
      for (const [key, value] of Object.entries(s.auth.headers)) {
        if (!isCredentialRef(value) && !authReported.has(`${s.name}\0auth.headers.${key}`)) add({ server: s.name, field: `auth.headers.${key}` });
      }
    }
  }
  return [...found.values()].sort((a, b) => (a.server === b.server ? a.field.localeCompare(b.field) : a.server.localeCompare(b.server)));
}

function renderSecrets(config: LoadedConfig, home: string | undefined): string[] {
  const secrets = findSecrets(config);
  if (secrets.length === 0) return ['secrets: no plaintext credentials found'];
  const lines = ['secrets:'];
  for (const s of secrets) {
    const key = s.field.replace(/^(?:env|headers|auth\.headers)\./, '');
    lines.push(`  ${s.server}: ${key} ${s.file ? `in ${shorten(s.file, home)} ` : ''}is plaintext`);
    lines.push(`    next: set servers.${s.server}.${s.field} to an env:, file: or keychain: reference in your via config`);
  }
  return lines;
}

// config -------------------------------------------------------------------------------------

const DIAGNOSTIC_NEXT: Partial<Record<ConfigDiagnostic['code'], string>> = {
  'cmd-forbidden': 'define the server in the user config, or use an env:, file: or keychain: reference',
  'trust-store-corrupt': 'remove the file, then run via trust again for the project files you rely on',
};

function renderConfigProblems(input: DoctorInput): string[] {
  const lines: string[] = [];
  const diagnostics = input.config.diagnostics.filter((d) => d.level !== 'info' && d.code !== 'plaintext-credential');
  // Errors first, each group in load order.
  for (const level of ['error', 'warning'] as const) {
    for (const d of diagnostics.filter((x) => x.level === level)) {
      lines.push(`  ${level}: ${formatDiagnostic({ ...d, ...(d.file ? { file: shorten(d.file, input.home) } : {}) })}`);
      const next = DIAGNOSTIC_NEXT[d.code];
      if (next) lines.push(`    next: ${next}`);
    }
  }
  for (const w of input.catalogWarnings ?? []) {
    lines.push(`  warning: ${w.message}`);
    if (w.code === 'reserved-name') lines.push(`    next: set servers.${w.provider}.alias in your via config`);
  }
  return lines.length > 0 ? ['config:', ...lines] : [];
}

// ---------------------------------------------------------------------------------------------

export function renderDoctor(input: DoctorInput): DoctorOutput {
  const rows = collectRows(input);
  const config = renderConfigProblems(input);
  const pins = new Map(input.config.servers.flatMap((s) => (s.protocolVersion !== undefined ? [[s.name, s.protocolVersion] as const] : [])));
  const sections = [renderServers(rows, input.home, pins), ...environment(input), renderFrameworks(input), renderSecrets(input.config, input.home)];
  if (config.length > 0) sections.push(config);

  let exitCode: number = ExitCode.Ok;
  for (const row of rows) exitCode = Math.max(exitCode, STATUS_EXIT[row.status]);
  if (input.config.diagnostics.some((d) => d.level === 'error')) exitCode = Math.max(exitCode, ExitCode.Usage);

  return { text: sections.map((s) => s.join('\n')).join('\n\n'), exitCode };
}
