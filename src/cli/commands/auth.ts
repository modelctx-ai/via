// `via auth login|status|logout` (auth.md, "OAuth"). Login is the only place an authorization
// happens; calls never start one. This file is the terminal side: it resolves the provider,
// wires the person-facing I/O into the flow in client/oauth/, and prints the outcome.
import type { LoginIO, LoginStatus, LoginTarget } from '../../client/oauth';
import type { ServerConfig } from '../../config';
import { userConfigHint } from '../../config/paths';
import { ExitCode } from '../../render/exit-codes';
import { shellArg } from '../../render/shell';
import { alignRows } from '../../render/width';
import type { App } from '../app';
import { authState, type AuthState } from '../auth-state';
import type { ProviderEntry } from '../directory';
import { fail, usageFailure } from '../failure';
import { parseLocal } from '../options';
import { resolveEntry } from '../target';

const USAGE = 'usage: via auth login <provider> [--manual] | via auth status [<provider>] | via auth logout <provider>';

/** Default wait for a login to finish (auth.md); `--timeout` overrides. */
const LOGIN_TIMEOUT_MS = 300_000;

export async function authCommand(app: App, argv: readonly string[]): Promise<number> {
  const action = argv[0]?.toLowerCase();
  const rest = argv.slice(1);
  switch (action) {
    case 'login':
      return login(app, rest);
    case 'status':
      return status(app, rest);
    case 'logout':
      return logout(app, rest);
    default:
      throw usageFailure(argv[0] === undefined ? USAGE : `unknown auth action: ${argv[0].slice(0, 40)}`, 'via auth -h', argv[0] === undefined ? [] : [USAGE]);
  }
}

/** The OAuth server a login/logout is about, or the failure that says why it cannot be. */
async function oauthServer(app: App, name: string): Promise<{ entry: ProviderEntry; target: LoginTarget }> {
  const entry = await resolveEntry(app, name);
  const { server } = entry;
  const { oauthTarget } = await import('../../client/oauth');
  if (!server.trusted) throw (await import('../../client')).untrustedServer(server);
  const target = oauthTarget(server);
  if (target) return { entry, target };
  if (server.auth.type === 'oauth') {
    throw fail(ExitCode.Usage, `${entry.name} is a stdio server; auth: oauth applies to HTTP servers only`, `via servers`);
  }
  throw fail(ExitCode.Usage, `${entry.name} is not configured for OAuth (auth: ${describeMethod(server)})`, `set servers.${server.name}.auth to oauth in ${userConfigHint(app.io.platform)}`);
}

function describeMethod(server: ServerConfig): string {
  return server.auth.type === 'none' && server.transport.type === 'stdio' ? 'none, stdio server' : server.auth.type;
}

/** A failed login as a printable failure. */
function loginFailure(error: unknown): unknown {
  if (error instanceof Error && error.name === 'LoginFailedError') {
    const e = error as Error & { exitCode: 2 | 4 | 6; next?: string };
    return fail(e.exitCode, e.message, e.next);
  }
  return error;
}

async function login(app: App, argv: readonly string[]): Promise<number> {
  const { flags, positionals } = parseLocal('auth login', argv, [{ name: 'manual', value: false }]);
  if (positionals.length !== 1) throw usageFailure(USAGE, 'via auth -h');
  const { entry, target } = await oauthServer(app, positionals[0]!);
  const manual = flags.manual === true;
  const { performLogin, openBrowser, formatDuration } = await import('../../client/oauth');
  const resolver = await app.resolver();

  const io: LoginIO = {
    showUrl: (url) => app.out(`${url}\n`),
    note: (text) => app.err(`· ${text}\n`),
    openUrl: (url) => (app.io.openUrl ? app.io.openUrl(url) : openBrowser(url, app.io.env, app.io.platform)),
    // The question is printed on stderr by `ask`; end of input is an empty answer.
    readLine: (prompt) => app.io.ask(prompt),
  };
  let result: Awaited<ReturnType<typeof performLogin>>;
  try {
    result = await performLogin({
      target,
      store: await app.oauthStore(),
      manual,
      timeoutMs: app.options.timeoutMs ?? LOGIN_TIMEOUT_MS,
      io,
      track: (value) => resolver.track?.(value),
      now: app.io.now,
    });
  } catch (error) {
    throw loginFailure(error);
  }

  const { record, set } = result;
  const details: string[] = [];
  if (record.scope) details.push(`scopes: ${record.scope}`);
  if (record.expiresAt !== undefined) details.push(`access token expires in ${formatDuration(record.expiresAt - app.io.now())}`);
  details.push(set.location.kind === 'keychain' ? 'stored in the system keychain' : `stored in ${set.location.path}`);
  if (set.fallbackReason) app.err(`· ${set.fallbackReason}; the login was saved to a private file instead (mode 0600)\n`);
  app.out(`logged in: ${entry.name}${details.length > 0 ? ` (${details.join('; ')})` : ''}\n`);
  return ExitCode.Ok;
}

interface StatusRow {
  provider: string;
  method: AuthState['method'];
  state: string;
  expiresAt?: number;
  scopes?: string;
  account?: string;
  store?: string;
  missing?: string[];
}

function loginPhrase(login: LoginStatus, now: number, format: (ms: number) => string): string {
  switch (login.state) {
    case 'not-logged-in':
      return 'not logged in';
    case 'expired':
      return 'expired';
    case 'refreshable':
      return 'access token expired (refreshes on next call)';
    default:
      return login.expiresAt === undefined ? 'logged in' : `logged in, expires in ${format(login.expiresAt - now)}`;
  }
}

async function status(app: App, argv: readonly string[]): Promise<number> {
  const { positionals } = parseLocal('auth status', argv, []);
  if (positionals.length > 1) throw usageFailure(USAGE, 'via auth -h');
  const { formatDuration } = await import('../../client/oauth');
  const entries = positionals[0] === undefined ? (await app.table()).entries : [await resolveEntry(app, positionals[0])];
  const now = app.io.now();
  const rows: StatusRow[] = [];
  let unusable: string | undefined;
  for (const entry of entries) {
    const state = await authState(app, entry.server);
    const row: StatusRow = { provider: entry.name, method: state.method, state: '' };
    if (state.method === 'oauth') {
      const login = state.login!;
      row.state = state.storeError ? `cannot read saved logins (${state.storeError})` : loginPhrase(login, now, formatDuration);
      if (login.expiresAt !== undefined) row.expiresAt = login.expiresAt;
      if (login.scope) row.scopes = login.scope;
      if (login.account) row.account = login.account;
      if (login.location) row.store = login.location.kind === 'keychain' ? 'keychain' : `file ${login.location.path ?? ''}`.trim();
    } else if (state.method === 'none') {
      row.state = 'no credentials';
    } else {
      row.state = state.missing.length > 0 ? `missing ${state.missing.join(', ')}` : 'credentials resolve';
      if (state.missing.length > 0) row.missing = state.missing;
    }
    rows.push(row);
    if (!state.usable && state.method !== 'none') unusable ??= entry.name;
  }

  if (app.options.format === 'json') {
    app.out(`${JSON.stringify(rows)}\n`);
  } else if (rows.length === 0) {
    app.out('no MCP servers found\n');
  } else {
    app.out(
      `${alignRows(
        rows.map((r) => {
          const details: string[] = [];
          if (r.account) details.push(`account: ${r.account}`);
          if (r.scopes) details.push(`scopes: ${r.scopes}`);
          if (r.store) details.push(`store: ${r.store}`);
          return [r.provider, r.method, r.state, details.join(' · ')];
        }),
      ).join('\n')}\n`,
    );
  }
  // A named provider that cannot authenticate is the answer "no" to a question scripts ask.
  if (positionals[0] !== undefined && unusable !== undefined) {
    const row = rows[0]!;
    app.err(`next: ${row.method === 'oauth' ? `via auth login ${shellArg(row.provider, { placeholder: 'provider', positional: true })}` : 'via doctor'}\n`);
    return ExitCode.Auth;
  }
  return ExitCode.Ok;
}

async function logout(app: App, argv: readonly string[]): Promise<number> {
  const { positionals } = parseLocal('auth logout', argv, []);
  if (positionals.length !== 1) throw usageFailure(USAGE, 'via auth -h');
  const { entry, target } = await oauthServer(app, positionals[0]!);
  const { performLogout } = await import('../../client/oauth');
  let result: Awaited<ReturnType<typeof performLogout>>;
  try {
    result = await performLogout({ target, store: await app.oauthStore() });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : 'unknown error';
    throw fail(ExitCode.Internal, `cannot delete the saved login of ${entry.name}: ${reason}`, 'via doctor');
  }
  if (!result.removed) {
    app.out(`not logged in: ${entry.name}\n`);
    return ExitCode.Ok;
  }
  const note =
    result.revoke === 'revoked'
      ? 'tokens revoked at the server'
      : result.revoke === 'unsupported'
        ? 'local login deleted; the server has no revocation endpoint'
        : result.revoke === 'failed'
          ? 'local login deleted; revoking at the server failed'
          : 'local login deleted';
  app.out(`logged out: ${entry.name} (${note})\n`);
  return ExitCode.Ok;
}
