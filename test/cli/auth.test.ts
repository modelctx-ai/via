import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startOAuthServer, type OAuthServer, type OAuthServerOptions } from '../fixtures/mcp/oauth-server.mjs';
import { makeSandbox, useCleanup, type CliResult, type Sandbox } from './helpers';

// auth.md, "OAuth": login (browser and --manual), refresh at call time, needs-auth, status, logout.
// A mock authorization server + protected MCP server (test/fixtures/mcp/oauth-server.mjs) plays the
// remote side; the "browser" is driven in code. The clock is the one `via` is given, so expiry is
// simulated by moving `now`, not by sleeping.

const T0 = Date.now();
const HOUR = 3_600_000;

async function setup(options: OAuthServerOptions = {}, extraServerConfig = '') {
  const srv = await startOAuthServer(options);
  useCleanup(() => srv.close());
  const sb = makeSandbox({});
  sb.userConfig(`sources: false\nservers:\n  linear:\n    url: ${srv.url}\n    auth: oauth\n${extraServerConfig}`);
  return { srv, sb };
}

/** The browser: follows the authorization URL, lands on via's loopback listener. */
const browser = (srv: OAuthServer) => async (url: string) => {
  srv.browse(url).catch(() => undefined);
  return { opened: true };
};

async function login(sb: Sandbox, srv: OAuthServer, args: string[] = []): Promise<CliResult> {
  return sb.via(['auth', 'login', 'linear', ...args], { now: T0, openUrl: browser(srv) });
}

function oauthFiles(sb: Sandbox): string[] {
  const dir = join(sb.home, '.local', 'share', 'via', 'oauth');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
}

function recordFile(sb: Sandbox): string {
  const files = oauthFiles(sb);
  expect(files).toHaveLength(1);
  return join(sb.home, '.local', 'share', 'via', 'oauth', files[0]!);
}

function readRecord(sb: Sandbox): { tokens?: { access_token: string; refresh_token?: string }; expiresAt?: number; clientInformation?: { client_id: string } } {
  return JSON.parse(readFileSync(recordFile(sb), 'utf8'));
}

/** Nothing the server ever issued may show up in what via printed. */
function expectNoTokens(srv: OAuthServer, ...results: CliResult[]): void {
  const secrets = [...srv.issuedAccessTokens(), ...srv.issuedRefreshTokens()];
  expect(secrets.length).toBeGreaterThan(0);
  for (const r of results) {
    for (const s of secrets) {
      expect(r.stdout).not.toContain(s);
      expect(r.stderr).not.toContain(s);
    }
  }
}

describe('via auth login', () => {
  it('logs in through the browser flow: discovery, registration, PKCE, loopback callback', async () => {
    const { srv, sb } = await setup();
    const r = await login(sb, srv);
    expect(r.stderr).toContain('· opened the URL in your browser');
    expect(r.stderr).toMatch(/· waiting for the authorization on http:\/\/127\.0\.0\.1:\d+\/callback/);
    expect(r.code).toBe(0);

    // The authorization URL is the command's data, printed first.
    const url = new URL(r.stdout.split('\n')[0]!);
    expect(url.origin).toBe(srv.issuer);
    expect(url.pathname).toBe('/authorize');
    expect(r.stdout).toMatch(/\nlogged in: linear \(scopes: read write; access token expires in 1h; stored in .*[\\/]oauth[\\/]oauth-[0-9a-f]{32}\.json\)\n$/);

    // Dynamic registration: a public client with the loopback redirect URI.
    expect(srv.state.registrations).toHaveLength(1);
    const reg = srv.state.registrations[0]!;
    expect(reg).toMatchObject({ client_name: 'via', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
    expect(reg.redirect_uris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    // The scope advertised by the 401 challenge, PKCE S256, a random state, and the RFC 8707 resource.
    const auth = srv.state.authorizeRequests[0]!;
    expect(auth).toMatchObject({ response_type: 'code', code_challenge_method: 'S256', scope: 'read write', resource: srv.url, redirect_uri: reg.redirect_uris[0] });
    expect(auth.state!.length).toBeGreaterThan(20);
    // The server verified the PKCE verifier; the exchange carried it.
    expect(srv.state.tokenRequests[0]).toMatchObject({ grant_type: 'authorization_code', redirect_uri: reg.redirect_uris[0] });
    expect(srv.state.tokenRequests[0]!.code_verifier).toBeTruthy();

    expectNoTokens(srv, r);
  });

  it('stores the login in a private file (0600, directory 0700) when the keychain is not used', async () => {
    const { srv, sb } = await setup();
    await login(sb, srv);
    const file = recordFile(sb);
    // Windows has no mode bits; the file is protected by the profile directory's ACL (security.md).
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
    }
    const record = readRecord(sb);
    expect(record.tokens?.access_token).toBeTruthy();
    expect(record.expiresAt).toBe(T0 + HOUR);
    // Nothing else on disk holds a token: config and cache directories stay clean.
    expect(readFileSync(join(sb.home, '.config', 'via', 'config.yaml'), 'utf8')).not.toContain(record.tokens!.access_token);
  });

  it('--manual prints the URL and reads the redirect URL from the terminal; no browser, no listener', async () => {
    const { srv, sb } = await setup();
    let opened = 0;
    const r = await sb.via(['auth', 'login', 'linear', '--manual'], {
      now: T0,
      openUrl: async () => {
        opened += 1;
        return { opened: true };
      },
      // The person authorizes elsewhere and pastes the page they landed on.
      readLine: async ({ stdout }) => srv.approve(stdout.split('\n')[0]!),
    });
    expect(r.code).toBe(0);
    expect(opened).toBe(0);
    expect(r.asked).toEqual(['paste the redirect URL: ']);
    expect(r.stderr).not.toContain('waiting for the authorization on');
    expect(r.stdout).toMatch(/^https?:\/\/.*\/authorize\?/);
    expect(r.stdout).toContain('logged in: linear');
    expect(srv.state.registrations[0]!.redirect_uris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(readRecord(sb).tokens?.access_token).toBeTruthy();
    expectNoTokens(srv, r);
  });

  it('--manual accepts the bare query string and keeps asking after a bad paste', async () => {
    const { srv, sb } = await setup();
    const answers: string[] = [];
    const r = await sb.via(['auth', 'login', 'linear', '--manual'], {
      now: T0,
      readLine: async ({ stdout }) => {
        if (answers.length === 0) {
          answers.push('not a url');
          return 'not a url';
        }
        const landed = await srv.approve(stdout.split('\n')[0]!);
        answers.push('query');
        return new URL(landed).search;
      },
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('that does not contain a code or an error');
  });

  it('--manual rejects a redirect whose state is not the one that was sent (exit 4, nothing stored)', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['auth', 'login', 'linear', '--manual'], {
      now: T0,
      readLine: async ({ stdout }) => {
        const landed = new URL(await srv.approve(stdout.split('\n')[0]!));
        landed.searchParams.set('state', 'forged');
        return landed.href;
      },
    });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('error: linear: the authorization response does not belong to this login (state mismatch)');
    expect(r.stderr).toContain('next: via auth login linear --manual');
    expect(srv.state.tokenRequests).toHaveLength(0);
    expect(oauthFiles(sb)).toEqual([]);
  });

  it('--manual at end of input fails with a hint instead of waiting', async () => {
    const { sb } = await setup();
    const r = await sb.via(['auth', 'login', 'linear', '--manual'], { now: T0, stdin: '' });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('no redirect URL with an authorization code was given');
  });

  it('reports a denied authorization (exit 4)', async () => {
    const { srv, sb } = await setup();
    srv.state.denyNext = true;
    const r = await login(sb, srv);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('error: linear: authorization was not granted (access_denied): The user said no');
    expect(r.stderr).toContain('next: via auth login linear');
  });

  it('does not wait for ever when nobody approves (exit 4 with a hint to use --manual)', async () => {
    const { sb } = await setup();
    const started = Date.now();
    const r = await sb.via(['auth', 'login', 'linear', '--timeout', '0.3'], { now: T0 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.code).toBe(4);
    // No browser here: the URL is printed and the run says why nothing was opened.
    expect(r.stderr).toContain('not opening a browser (tests do not open browsers)');
    expect(r.stderr).toContain('error: linear: timed out waiting for the authorization');
  });

  it('needs a registered client when the server has no dynamic registration', async () => {
    const { sb } = await setup({ dcr: false });
    const r = await sb.via(['auth', 'login', 'linear'], { now: T0 });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('does not support dynamic client registration');
    expect(r.stderr).toContain('clientId');
  });

  it('uses the configured clientId and scopes without registering', async () => {
    const { srv, sb } = await setup({ dcr: false });
    sb.userConfig(`sources: false\nservers:\n  linear:\n    url: ${srv.url}\n    auth: { oauth: { clientId: preregistered, scopes: [read] } }\n`);
    let authUrl = '';
    // Nobody approves: the flow times out, but the request it sent is what is being looked at.
    const r = await sb.via(['auth', 'login', 'linear', '--timeout', '0.5'], {
      now: T0,
      openUrl: async (url) => {
        authUrl = url;
        return { opened: true };
      },
    });
    expect(r.code).toBe(4);
    expect(srv.state.registrations).toHaveLength(0);
    const params = new URL(authUrl).searchParams;
    expect(params.get('client_id')).toBe('preregistered');
    expect(params.get('scope')).toBe('read');
  });

  it('refuses servers that are not configured for OAuth', async () => {
    const { srv, sb } = await setup();
    sb.userConfig(`sources: false\nservers:\n  linear:\n    url: ${srv.url}\n    auth: { bearer: "env:X_TOKEN_VALUE" }\n  local:\n    command: node\n    args: [x.js]\n    auth: oauth\n`);
    const bearer = await sb.via(['auth', 'login', 'linear']);
    expect(bearer.code).toBe(2);
    expect(bearer.stderr).toContain('error: linear is not configured for OAuth (auth: bearer)');
    expect(bearer.stderr).toContain('next: set servers.linear.auth to oauth');
    const stdio = await sb.via(['auth', 'login', 'local']);
    expect(stdio.code).toBe(2);
    expect(stdio.stderr).toContain('is a stdio server; auth: oauth applies to HTTP servers only');
  });

  it('refuses an untrusted project-level server (the URL could send the login anywhere)', async () => {
    const srv = await startOAuthServer();
    useCleanup(() => srv.close());
    const sb = makeSandbox({});
    sb.projectConfig(`servers:\n  linear:\n    url: ${srv.url}\n    auth: oauth\n`);
    const r = await sb.via(['auth', 'login', 'linear']);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain('untrusted project config');
    expect(srv.state.registrations).toHaveLength(0);
  });

  it('usage errors', async () => {
    const { sb } = await setup();
    expect((await sb.via(['auth'])).code).toBe(2);
    expect((await sb.via(['auth', 'login'])).code).toBe(2);
    expect((await sb.via(['auth', 'frobnicate'])).stderr).toContain('unknown auth action: frobnicate');
    expect((await sb.via(['auth', 'login', 'nope'])).code).toBe(3);
    expect((await sb.via(['auth', '-h'])).stdout).toContain('via auth login <provider> [--manual]');
  });
});

describe('calls with an OAuth server', () => {
  it('works after login and never prints the access token', async () => {
    const { srv, sb } = await setup();
    await login(sb, srv);
    const r = await sb.via(['linear', 'whoami'], { now: T0 });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('authorization: Bearer ***\n');
    const token = readRecord(sb).tokens!.access_token;
    expect(srv.state.mcp.at(-1)).toEqual({ valid: true, authorization: `Bearer ${token}` });
    expectNoTokens(srv, r);
    const json = await sb.via(['linear', 'whoami', '-o', 'json'], { now: T0 });
    expect(json.stdout + json.stderr).not.toContain(token);
  });

  it('refreshes an expired access token silently before the call', async () => {
    const { srv, sb } = await setup();
    await login(sb, srv);
    const before = readRecord(sb);
    const seen = srv.state.mcp.length; // the login probe's unauthenticated request is not part of the call
    const r = await sb.via(['linear', 'whoami'], { now: T0 + 2 * HOUR });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('error');
    const refreshes = srv.state.tokenRequests.filter((t) => t.grant_type === 'refresh_token');
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toMatchObject({ refresh_token: before.tokens!.refresh_token, client_id: before.clientInformation!.client_id });
    // Nothing invalid ever reached the MCP endpoint, and the refreshed (rotated) tokens are saved.
    expect(srv.state.mcp.slice(seen).every((m) => m.valid)).toBe(true);
    const after = readRecord(sb);
    expect(after.tokens!.access_token).not.toBe(before.tokens!.access_token);
    expect(after.tokens!.refresh_token).not.toBe(before.tokens!.refresh_token);
    expect(after.expiresAt).toBe(T0 + 3 * HOUR);
    expectNoTokens(srv, r);
  });

  it('refreshes once and retries when the server rejects the token (401)', async () => {
    const { srv, sb } = await setup();
    await login(sb, srv);
    srv.expireAccessTokens();
    const r = await sb.via(['linear', 'whoami'], { now: T0 });
    expect(r.code).toBe(0);
    expect(srv.state.mcp.some((m) => !m.valid)).toBe(true);
    expect(srv.state.tokenRequests.filter((t) => t.grant_type === 'refresh_token')).toHaveLength(1);
    expect(srv.state.mcp.at(-1)!.valid).toBe(true);
  });

  it('exits 4 with the spec message when there has never been a login, without any request', async () => {
    const { srv, sb } = await setup();
    const call = await sb.via(['linear', 'whoami']);
    expect(call.code).toBe(4);
    expect(call.stdout).toBe('');
    expect(call.stderr).toBe('error: linear requires auth\nnext: ask the user to run this in a terminal: via auth login linear\n');
    // Not a single request left the machine: no probe, no registration, no browser.
    expect(srv.state.mcp).toHaveLength(0);
    expect(srv.state.registrations).toHaveLength(0);
    expect(srv.state.authorizeRequests).toHaveLength(0);
    const browse = await sb.via(['linear']);
    expect(browse.code).toBe(4);
    expect(srv.state.mcp).toHaveLength(0);
  });

  it('never opens a browser or waits for input during a call, even when the login is dead', async () => {
    const { srv, sb } = await setup();
    await login(sb, srv);
    srv.revokeRefreshTokens();
    let prompts = 0;
    const r = await sb.via(['linear', 'whoami'], {
      now: T0 + 2 * HOUR,
      openUrl: async () => {
        prompts += 1;
        return { opened: true };
      },
      readLine: async () => {
        prompts += 1;
        return undefined;
      },
    });
    expect(prompts).toBe(0);
    expect(r.code).toBe(4);
    expect(r.stderr).toBe('error: linear requires auth (the saved login expired)\nnext: ask the user to run this in a terminal: via auth login linear\n');
    expect(srv.state.authorizeRequests).toHaveLength(1); // only the one from the login
    // The dead tokens were dropped: the next call does not even try, and status agrees.
    const again = await sb.via(['linear', 'whoami'], { now: T0 + 2 * HOUR });
    expect(again.stderr).toBe('error: linear requires auth\nnext: ask the user to run this in a terminal: via auth login linear\n');
    expect((await sb.via(['auth', 'status', 'linear'], { now: T0 })).code).toBe(4);
    // Logging in again repairs it.
    expect((await login(sb, srv)).code).toBe(0);
    expect((await sb.via(['linear', 'whoami'], { now: T0 })).code).toBe(0);
  });

  it('a transient refresh failure is an upstream error (exit 6) and keeps the login', async () => {
    const { srv, sb } = await setup();
    await login(sb, srv);
    srv.state.tokenFailure = 503;
    const r = await sb.via(['linear', 'whoami'], { now: T0 + 2 * HOUR });
    expect(r.code).toBe(6);
    expect(r.stderr).toContain('error: linear: could not refresh the saved login');
    expect(r.stderr).toContain('next: via doctor');
    expect(readRecord(sb).tokens?.refresh_token).toBeTruthy();
    srv.state.tokenFailure = undefined;
    expect((await sb.via(['linear', 'whoami'], { now: T0 + 2 * HOUR })).code).toBe(0);
  });

  it('redacts the token from errors that echo it', async () => {
    const { srv, sb } = await setup();
    await login(sb, srv);
    srv.state.mcpFailure = { status: 500, echo: true };
    const r = await sb.via(['linear', 'whoami'], { now: T0 });
    expect(r.code).toBe(6);
    expect(r.stderr).toContain('Bearer ***');
    expectNoTokens(srv, r);
  });

  it('a server that rejects even a fresh token reports the credentials as rejected (exit 4)', async () => {
    const { srv, sb } = await setup();
    await login(sb, srv);
    // Keep forgetting tokens: the refreshed one is refused too.
    const forget = setInterval(() => srv.expireAccessTokens(), 1);
    useCleanup(() => clearInterval(forget));
    const r = await sb.via(['linear', 'whoami'], { now: T0 });
    clearInterval(forget);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('linear rejected the credentials (HTTP 401)');
    expect(r.stderr).toContain('next: ask the user to run this in a terminal: via auth login linear');
  });
});

describe('via auth status', () => {
  it('shows method, state, expiry, scopes and store, never a token', async () => {
    const { srv, sb } = await setup({ idToken: true });
    sb.userConfig(`sources: false\nservers:\n  linear:\n    url: ${srv.url}\n    auth: oauth\n  gh:\n    url: ${srv.url}\n    auth: { bearer: "env:GH_TOKEN" }\n  open:\n    url: https://open.example/mcp\n`);
    const before = await sb.via(['auth', 'status'], { env: { GH_TOKEN: 'fake-gh-token-for-status' } });
    expect(before.code).toBe(0);
    expect(before.stdout).toMatch(/^linear\s+oauth\s+not logged in/m);
    expect(before.stdout).toMatch(/^gh\s+bearer\s+credentials resolve/m);
    expect(before.stdout).toMatch(/^open\s+none\s+no credentials/m);

    await login(sb, srv);
    const r = await sb.via(['auth', 'status'], { now: T0 + 10 * 60_000, env: { GH_TOKEN: 'fake-gh-token-for-status' } });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^linear\s+oauth\s+logged in, expires in 50m\s+account: user@example\.com · scopes: read write · store: file .*\.json$/m);
    expectNoTokens(srv, r);

    const one = await sb.via(['auth', 'status', 'linear'], { now: T0 });
    expect(one.code).toBe(0);
    expect(one.stdout.trim().split('\n')).toHaveLength(1);

    const json = await sb.via(['auth', 'status', '-o', 'json'], { now: T0 + 10 * 60_000, env: { GH_TOKEN: 'fake-gh-token-for-status' } });
    const rows = JSON.parse(json.stdout) as Array<Record<string, unknown>>;
    expect(rows.find((x) => x.provider === 'linear')).toMatchObject({
      method: 'oauth',
      state: 'logged in, expires in 50m',
      expiresAt: T0 + HOUR,
      scopes: 'read write',
      account: 'user@example.com',
    });
    expectNoTokens(srv, json);
  });

  it('distinguishes an expired access token that can be refreshed', async () => {
    const { srv, sb } = await setup();
    await login(sb, srv);
    const r = await sb.via(['auth', 'status', 'linear'], { now: T0 + 2 * HOUR });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('access token expired (refreshes on next call)');
  });

  it('a named provider that is not logged in exits 4 with the next step', async () => {
    const { sb } = await setup();
    const r = await sb.via(['auth', 'status', 'linear']);
    expect(r.code).toBe(4);
    expect(r.stdout).toMatch(/^linear\s+oauth\s+not logged in/);
    expect(r.stderr).toBe('next: via auth login linear\n');
  });
});

describe('via auth logout', () => {
  it('revokes the tokens at the server and deletes the local record', async () => {
    const { srv, sb } = await setup();
    await login(sb, srv);
    const tokens = readRecord(sb).tokens!;
    const r = await sb.via(['auth', 'logout', 'linear'], { now: T0 });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('logged out: linear (tokens revoked at the server)\n');
    expect(srv.state.revocations.map((x) => x.token_type_hint).sort()).toEqual(['access_token', 'refresh_token']);
    expect(srv.state.revocations.map((x) => x.token).sort()).toEqual([tokens.access_token, tokens.refresh_token].sort());
    expect(oauthFiles(sb)).toEqual([]);
    expect((await sb.via(['auth', 'status', 'linear'])).code).toBe(4);
    const call = await sb.via(['linear', 'whoami']);
    expect(call.stderr).toBe('error: linear requires auth\nnext: ask the user to run this in a terminal: via auth login linear\n');
    const again = await sb.via(['auth', 'logout', 'linear']);
    expect(again.code).toBe(0);
    expect(again.stdout).toBe('not logged in: linear\n');
    expectNoTokens(srv, r);
  });

  it('still deletes the local record when the server has no revocation endpoint', async () => {
    const { srv, sb } = await setup({ revocation: false });
    await login(sb, srv);
    const r = await sb.via(['auth', 'logout', 'linear']);
    expect(r.stdout).toBe('logged out: linear (local login deleted; the server has no revocation endpoint)\n');
    expect(srv.state.revocations).toHaveLength(0);
  });

  it('deletes a record that was corrupted by hand', async () => {
    const { srv, sb } = await setup();
    await login(sb, srv);
    writeFileSync(recordFile(sb), '{ not json');
    expect((await sb.via(['auth', 'status', 'linear'])).stdout).toContain('not logged in');
    expect((await sb.via(['auth', 'logout', 'linear'])).code).toBe(0);
  });
});

describe('via servers and via doctor with OAuth', () => {
  it('servers shows the login state in the auth column', async () => {
    const { srv, sb } = await setup();
    expect((await sb.via(['servers'])).stdout).toMatch(/linear\s+http http:\/\/127\.0\.0\.1:\d+\s+-\s+oauth \(not logged in\)/);
    await login(sb, srv);
    expect((await sb.via(['servers'], { now: T0 })).stdout).toContain('oauth (logged in, expires in 1h)');
    expect((await sb.via(['servers'], { now: T0 + 2 * HOUR })).stdout).toContain('oauth (access token expired, refreshable)');
  });

  it('doctor reports a missing login as needs auth with the login command, and a working one as ok', async () => {
    const { srv, sb } = await setup();
    const before = await sb.via(['doctor']);
    expect(before.code).toBe(4);
    expect(before.stdout).toContain('1 needs auth (linear)');
    expect(before.stdout).toContain('next: ask the user to run this in a terminal: via auth login linear');
    expect(srv.state.mcp).toHaveLength(0);
    await login(sb, srv);
    const after = await sb.via(['doctor'], { now: T0 });
    expect(after.code).toBe(0);
    expect(after.stdout).toContain('1 ok');
    expectNoTokens(srv, before, after);
  });

  it('the top-level view marks the provider as needing auth', async () => {
    const { sb } = await setup();
    const r = await sb.via([]);
    expect(r.stdout).toContain('needs auth');
  });
});

describe('client credentials and pre-registered secrets through the CLI', () => {
  const SECRET = 'cli-test-client-secret-value';

  async function machine(options: OAuthServerOptions = {}, oauth = 'grant: client_credentials, clientId: ci-client, clientSecret: "env:CI_SECRET"') {
    const srv = await startOAuthServer({ machine: { clientId: 'ci-client', clientSecret: SECRET }, ...options });
    useCleanup(() => srv.close());
    const sb = makeSandbox({});
    sb.userConfig(`sources: false\nservers:\n  ci:\n    url: ${srv.url}\n    auth: { oauth: { ${oauth} } }\n`);
    return { srv, sb };
  }

  const env = { CI_SECRET: SECRET };
  const noBrowser = {
    openUrl: async () => {
      throw new Error('the machine grant must not open a browser');
    },
    readLine: async () => {
      throw new Error('the machine grant must not ask for input');
    },
  };

  it('login validates the credentials without a browser; calls then work and nothing secret is printed', async () => {
    const { srv, sb } = await machine();
    const r = await sb.via(['auth', 'login', 'ci'], { env, now: T0, ...noBrowser });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^logged in: ci \(client credentials; scopes: read write; access token expires in 1h; stored in .+\)\n$/);
    expect(srv.state.authorizeRequests).toHaveLength(0);
    expect(srv.state.tokenAuth).toEqual([{ grantType: 'client_credentials', clientId: 'ci-client', method: 'basic' }]);
    const call = await sb.via(['ci', 'whoami'], { env, now: T0, ...noBrowser });
    expect(call.code).toBe(0);
    expect(srv.state.tokenAuth).toHaveLength(1); // the saved token is used
    for (const out of [r, call]) {
      expect(out.stdout + out.stderr).not.toContain(SECRET);
      for (const token of srv.issuedAccessTokens()) expect(out.stdout + out.stderr).not.toContain(token);
    }
    const files = readFileSync(recordFile(sb), 'utf8');
    expect(files).not.toContain(SECRET);
    expect(JSON.parse(files)).toMatchObject({ grant: 'client_credentials', issuer: srv.issuer });
  });

  it('needs no login: the first call asks for the token, and an expired one is asked for again', async () => {
    const { srv, sb } = await machine();
    expect((await sb.via(['ci', 'whoami'], { env, now: T0, ...noBrowser })).code).toBe(0);
    expect(srv.state.tokenAuth).toHaveLength(1);
    expect((await sb.via(['ci', 'whoami'], { env, now: T0 + 2 * HOUR, ...noBrowser })).code).toBe(0);
    expect(srv.state.tokenAuth.map((t) => t.grantType)).toEqual(['client_credentials', 'client_credentials']);
  });

  it('a secret that does not resolve is exit 4 with the usual next: and nothing is sent', async () => {
    const { srv, sb } = await machine();
    const r = await sb.via(['ci', 'whoami'], { env: {}, now: T0 });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('CI_SECRET');
    expect(srv.state.tokenAuth).toHaveLength(0);
    expect(srv.state.mcp).toHaveLength(0);
  });

  it('a refused secret is exit 4 and says so without the secret', async () => {
    const { srv, sb } = await machine();
    const r = await sb.via(['ci', 'whoami'], { env: { CI_SECRET: 'definitely-not-the-secret' }, now: T0 });
    expect(r.code).toBe(4);
    expect(r.stderr).toBe('error: ci: the authorization server refused the client credentials (invalid_client)\nnext: check auth.oauth of ci in your via config\n');
    expect(r.stdout + r.stderr).not.toContain('definitely-not-the-secret');
    expect(srv.state.mcp.every((request) => !request.valid)).toBe(true); // only the discovery probe reached the MCP endpoint
  });

  it('status and servers describe the machine grant, and logout removes only the saved token', async () => {
    const { srv, sb } = await machine();
    expect((await sb.via(['servers'], { env, now: T0 })).stdout).toContain('oauth (client credentials, token requested on use)');
    const noSecret = await sb.via(['auth', 'status', 'ci'], { env: {}, now: T0 });
    expect(noSecret.code).toBe(4);
    expect(noSecret.stdout).toContain('client credentials, missing env:CI_SECRET');
    await sb.via(['auth', 'login', 'ci'], { env, now: T0 });
    const status = await sb.via(['auth', 'status', 'ci'], { env, now: T0 });
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/^ci\s+oauth\s+client credentials, token expires in 1h/);
    expect((await sb.via(['servers'], { env, now: T0 })).stdout).toContain('oauth (client credentials, token expires in 1h)');
    const out = await sb.via(['auth', 'logout', 'ci'], { env, now: T0 });
    expect(out.stdout).toBe('logged out: ci (local login deleted)\n');
    expect(srv.state.revocations).toHaveLength(0);
    expect(oauthFiles(sb)).toEqual([]);
  });

  it('a pre-registered confidential client logs in through the browser flow with its secret', async () => {
    const srv = await startOAuthServer({ dcr: false, preRegistered: { clientId: 'pre', clientSecret: SECRET } });
    useCleanup(() => srv.close());
    const sb = makeSandbox({});
    sb.userConfig(`sources: false\nservers:\n  linear:\n    url: ${srv.url}\n    auth: { oauth: { clientId: pre, clientSecret: "env:PRE_SECRET" } }\n`);
    const r = await sb.via(['auth', 'login', 'linear'], { env: { PRE_SECRET: SECRET }, now: T0, openUrl: browser(srv) });
    expect(r.code).toBe(0);
    expect(srv.state.tokenAuth).toEqual([{ grantType: 'authorization_code', clientId: 'pre', method: 'basic' }]);
    expect(r.stdout + r.stderr).not.toContain(SECRET);
    expect(readFileSync(recordFile(sb), 'utf8')).not.toContain(SECRET);
    expect((await sb.via(['linear', 'whoami'], { env: { PRE_SECRET: SECRET }, now: T0 })).code).toBe(0);
  });

  it('refuses to send the credentials to a different authorization server, with the way out in next:', async () => {
    const { srv, sb } = await machine();
    const other = await startOAuthServer({ machine: { clientId: 'ci-client', clientSecret: SECRET } });
    useCleanup(() => other.close());
    expect((await sb.via(['auth', 'login', 'ci'], { env, now: T0 })).code).toBe(0);
    srv.state.authorizationServers = [other.issuer];
    const r = await sb.via(['auth', 'login', 'ci'], { env, now: T0 });
    expect(r.code).toBe(4);
    expect(r.stderr).toBe(`error: ci: its authorization server changed from ${srv.issuer} to ${other.issuer}; the saved client credentials belong to the first and were not sent to the second\nnext: via auth logout ci\n`);
    expect(other.state.tokenAuth).toHaveLength(0);
    expect((await sb.via(['auth', 'logout', 'ci'], { env, now: T0 })).code).toBe(0);
    expect((await sb.via(['auth', 'login', 'ci'], { env, now: T0 })).code).toBe(0);
    expect(other.state.tokenAuth).toHaveLength(1);
  });
});
