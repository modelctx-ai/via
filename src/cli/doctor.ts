// `via doctor` (guides/agent-integration.md): connection and auth status per server, frameworks
// still injecting MCP schemas with their disable hints, plaintext secrets, config problems.
// Pure: the CLI probes the servers and prints the text; nothing here reads files or the network.
import { formatDiagnostic, isCredentialRef, type ConfigDiagnostic, type FrameworkDef, type LoadedConfig, type ServerConfig } from '../config';
import type { CatalogWarning } from '../catalog';
import { ExitCode } from '../render/exit-codes';
import { shortenHome } from '../config/paths';
import { shellWord } from '../render/shell';
import { displayWidth, padEndWidth, truncateChars } from '../render/width';

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
}

/** Probes, plus config servers nobody probed that are known to be unusable (untrusted, disabled). */
function collectRows(input: DoctorInput): Row[] {
  const byName = new Map(input.config.servers.map((s) => [s.name, s]));
  const rows: Row[] = input.probes.map((p) => {
    const row: Row = { server: p.server, provider: p.provider, status: p.status };
    if (p.message) row.message = oneLine(p.message);
    if (p.next) row.next = oneLine(p.next);
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
  if (row.status === 'needs-auth' && server?.auth.type === 'oauth') return [`via auth login ${row.provider}`];
  if (row.status === 'untrusted') {
    const paths = server?.untrustedPaths ?? [];
    return paths.length > 0 ? paths.map((p) => `via trust ${shellWord(p)}`) : ['via trust'];
  }
  return [];
}

function renderServers(rows: readonly Row[], home: string | undefined): string[] {
  if (rows.length === 0) return ['servers   none configured'];
  const parts: string[] = [`${rows.filter((r) => r.status === 'ok').length} ok`];
  for (const status of ['needs-auth', 'error', 'untrusted', 'disabled'] as const) {
    const names = rows.filter((r) => r.status === status).map((r) => r.provider);
    if (names.length > 0) parts.push(`${names.length} ${STATUS_LABEL[status]} (${names.join(', ')})`);
  }
  const lines = [`servers   ${parts.join(' · ')}`];
  for (const row of rows) {
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
  const sections = [renderServers(rows, input.home), renderFrameworks(input), renderSecrets(input.config, input.home)];
  if (config.length > 0) sections.push(config);

  let exitCode: number = ExitCode.Ok;
  for (const row of rows) exitCode = Math.max(exitCode, STATUS_EXIT[row.status]);
  if (input.config.diagnostics.some((d) => d.level === 'error')) exitCode = Math.max(exitCode, ExitCode.Usage);

  return { text: sections.map((s) => s.join('\n')).join('\n\n'), exitCode };
}
