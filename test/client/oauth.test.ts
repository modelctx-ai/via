import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InProcessClient } from '../../src/client';
import {
  accountOf,
  browserUnavailable,
  checkStoreWritable,
  createCallProvider,
  createMemoryOAuthStore,
  createOAuthStore,
  describeLogin,
  formatDuration,
  oauthKey,
  openBrowser,
  openerCommand,
  parseRedirect,
  performLogin,
  startLoopback,
  tokenState,
  type LoginIO,
  type OAuthKeyring,
  type OAuthRecord,
} from '../../src/client/oauth';
import { startOAuthServer, type OAuthServer } from '../fixtures/mcp/oauth-server.mjs';
import { FakeResolver, httpServer } from '../helpers/client';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function mockServer(options = {}): Promise<OAuthServer> {
  const srv = await startOAuthServer(options);
  cleanups.push(() => srv.close());
  return srv;
}

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'via-oauth-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A person who approves everything: the "browser" follows the URL to the loopback. */
function io(srv: OAuthServer): LoginIO {
  return {
    showUrl: () => undefined,
    note: () => undefined,
    openUrl: async (url) => {
      srv.browse(url).catch(() => undefined);
      return { opened: true };
    },
    readLine: async () => undefined,
  };
}

const T0 = Date.now();
const HOUR = 3_600_000;

async function loggedIn(srv: OAuthServer, store = createMemoryOAuthStore()) {
  const target = { provider: 'linear', url: srv.url };
  await performLogin({ target, store, manual: false, timeoutMs: 10_000, io: io(srv), now: () => T0 });
  return { store, target };
}

describe('oauthKey', () => {
  it('is stable, and changes with the URL, the client id and the scopes (not their order)', () => {
    const base = oauthKey({ url: 'https://mcp.example/mcp' });
    expect(base).toMatch(/^oauth:[0-9a-f]{32}$/);
    expect(oauthKey({ url: 'https://mcp.example/mcp' })).toBe(base);
    expect(oauthKey({ url: 'https://mcp.example/other' })).not.toBe(base);
    expect(oauthKey({ url: 'https://mcp.example/mcp', clientId: 'c' })).not.toBe(base);
    expect(oauthKey({ url: 'https://mcp.example/mcp', scopes: ['a'] })).not.toBe(base);
    expect(oauthKey({ url: 'https://mcp.example/mcp', scopes: ['a', 'b'] })).toBe(oauthKey({ url: 'https://mcp.example/mcp', scopes: ['b', 'a'] }));
  });
});

describe('OAuth store', () => {
  const record: OAuthRecord = { version: 1, serverUrl: 'https://mcp.example/mcp', tokens: { access_token: 'at-secret-value', token_type: 'Bearer' } };

  function fakeKeyring(initial: Record<string, string> = {}, failWith?: string): OAuthKeyring & { data: Record<string, string>; services: string[] } {
    const data = { ...initial };
    const services: string[] = [];
    return {
      data,
      services,
      AsyncEntry: class {
        constructor(
          private readonly service: string,
          private readonly account: string,
        ) {
          services.push(`${service}/${account}`);
        }
        async getPassword() {
          if (failWith) throw new Error(failWith);
          return data[this.account] ?? null;
        }
        async setPassword(value: string) {
          if (failWith) throw new Error(failWith);
          data[this.account] = value;
        }
        async deletePassword() {
          if (failWith) throw new Error(failWith);
          return delete data[this.account];
        }
      },
    };
  }

  it('prefers the keychain (service "via", account oauth:<hash>) and writes no file', async () => {
    const dir = join(tmp(), 'oauth');
    const keyring = fakeKeyring();
    const store = createOAuthStore({ dir, mode: 'auto', loadKeyring: async () => keyring });
    const key = oauthKey({ url: record.serverUrl });
    const set = await store.set(key, record);
    expect(set).toEqual({ location: { kind: 'keychain' } });
    expect(keyring.services[0]).toBe(`via/${key}`);
    expect(existsSync(dir)).toBe(false);
    expect((await store.get(key))?.location).toEqual({ kind: 'keychain' });
    expect(await store.delete(key)).toBe(true);
    expect(await store.get(key)).toBeUndefined();
  });

  it('falls back to a 0600 file in a 0700 directory when the keychain does not work', async () => {
    const dir = join(tmp(), 'oauth');
    const store = createOAuthStore({ dir, mode: 'auto', loadKeyring: async () => fakeKeyring({}, 'no secret service') });
    const key = oauthKey({ url: record.serverUrl });
    const set = await store.set(key, record);
    expect(set.location.kind).toBe('file');
    expect(set.fallbackReason).toBe('the system keychain is not available (no secret service)');
    const files = readdirSync(dir);
    expect(files).toEqual([`${key.replace(':', '-')}.json`]);
    expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect((await store.get(key))?.record.tokens?.access_token).toBe('at-secret-value');
    expect(await store.delete(key)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('finds a file record even when the keychain works but is empty, and moves it to the keychain on the next save', async () => {
    const dir = join(tmp(), 'oauth');
    const key = oauthKey({ url: record.serverUrl });
    await createOAuthStore({ dir, mode: 'file' }).set(key, record);
    const keyring = fakeKeyring();
    const store = createOAuthStore({ dir, mode: 'auto', loadKeyring: async () => keyring });
    expect((await store.get(key))?.location.kind).toBe('file');
    await store.set(key, record);
    expect(Object.keys(keyring.data)).toEqual([key]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('file mode never touches the keychain; keychain mode does not fall back', async () => {
    const dir = join(tmp(), 'oauth');
    const key = oauthKey({ url: record.serverUrl });
    const loadKeyring = async (): Promise<OAuthKeyring> => {
      throw new Error('must not be loaded');
    };
    await createOAuthStore({ dir, mode: 'file', loadKeyring }).set(key, record);
    const strict = createOAuthStore({ dir, mode: 'keychain', loadKeyring: async () => fakeKeyring({}, 'locked') });
    await expect(strict.set(key, record)).rejects.toThrow('cannot write to the system keychain: locked');
    await expect(strict.get(key)).rejects.toThrow('cannot read the system keychain: locked');
  });

  it('reads VIA_OAUTH_STORE', async () => {
    const dir = join(tmp(), 'oauth');
    const store = createOAuthStore({ dir, env: { VIA_OAUTH_STORE: 'file' }, loadKeyring: async () => fakeKeyring({}, 'would fail') });
    expect((await store.set('oauth:x', record)).fallbackReason).toBeUndefined();
  });

  it('treats a corrupt or foreign document as no login', async () => {
    const dir = join(tmp(), 'oauth');
    const store = createOAuthStore({ dir, mode: 'file' });
    await store.set('oauth:x', record);
    writeFileSync(join(dir, 'oauth-x.json'), '{"version":2}');
    expect(await store.get('oauth:x')).toBeUndefined();
    writeFileSync(join(dir, 'oauth-x.json'), 'not json');
    expect(await store.get('oauth:x')).toBeUndefined();
  });
});

describe('redirect handling', () => {
  it('parses a pasted landing URL, a bare query string, and an error response', () => {
    expect(parseRedirect('http://127.0.0.1:5000/callback?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' });
    expect(parseRedirect('  "http://127.0.0.1:5000/callback?code=abc&state=xyz"  ')).toEqual({ code: 'abc', state: 'xyz' });
    expect(parseRedirect('?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' });
    expect(parseRedirect('code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' });
    expect(parseRedirect('http://x/callback?error=access_denied&error_description=no')).toEqual({ error: 'access_denied', errorDescription: 'no' });
    expect(parseRedirect('')).toBeUndefined();
    expect(parseRedirect('hello')).toBeUndefined();
    expect(parseRedirect('http://x/callback?state=only')).toBeUndefined();
  });

  it('the loopback listener only answers the callback path for its own host and port', async () => {
    const loop = await startLoopback();
    cleanups.push(() => loop.close());
    const base = new URL(loop.redirectUrl);
    expect(base.hostname).toBe('127.0.0.1');
    expect((await fetch(`${base.origin}/other?code=x`)).status).toBe(404);
    expect((await fetch(`${base.origin}/callback`)).status).toBe(400);
    // A rebinding-style request names another host.
    const rebinding = await new Promise<number>((resolve) => {
      import('node:http').then(({ request }) => {
        const req = request({ host: '127.0.0.1', port: base.port, path: '/callback?code=evil&state=s', headers: { host: 'attacker.example' } }, (res) => resolve(res.statusCode ?? 0));
        req.end();
      });
    });
    expect(rebinding).toBe(404);
    const ok = await fetch(`${loop.redirectUrl}?code=good&state=s`);
    expect(ok.status).toBe(200);
    await expect(loop.response).resolves.toEqual({ code: 'good', state: 's' });
  });
});

describe('browser opening', () => {
  it('is skipped over SSH and without a display, and uses the platform opener otherwise', () => {
    expect(browserUnavailable({ SSH_CONNECTION: '1 2 3 4' }, 'darwin')).toBe('this is an SSH session');
    expect(browserUnavailable({ SSH_TTY: '/dev/pts/1', DISPLAY: ':0' }, 'linux')).toBe('this is an SSH session');
    expect(browserUnavailable({}, 'linux')).toBe('no display is available');
    expect(browserUnavailable({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBeUndefined();
    expect(browserUnavailable({}, 'darwin')).toBeUndefined();
    expect(openerCommand('https://a/b?c=1&d=2', 'darwin')).toEqual({ command: 'open', args: ['https://a/b?c=1&d=2'] });
    expect(openerCommand('https://a/b?c=1&d=2', 'linux')).toEqual({ command: 'xdg-open', args: ['https://a/b?c=1&d=2'] });
    expect(openerCommand('https://a/b?c=1&d=2', 'win32')).toEqual({ command: 'cmd', args: ['/c', 'start', '""', 'https://a/b?c=1^&d=2'] });
  });

  it('does not hang or throw when the opener does not exist', async () => {
    const started = Date.now();
    const result = await openBrowser('https://a/b', { PATH: '/nonexistent', DISPLAY: ':0' }, 'linux');
    expect(result.opened).toBe(false);
    expect(result.reason).toBe('xdg-open is not installed');
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await openBrowser('https://a/b', {}, 'linux')).reason).toBe('no display is available');
  });
});

describe('login state', () => {
  it('describes tokens, expiry and who is logged in', () => {
    const idToken = `x.${Buffer.from(JSON.stringify({ sub: 's1', email: 'a@b.c' })).toString('base64url')}.y`;
    expect(accountOf(idToken)).toBe('a@b.c');
    expect(accountOf('garbage')).toBeUndefined();
    const loc = { kind: 'file', path: '/p' } as const;
    const rec = (over: Partial<OAuthRecord>): { record: OAuthRecord; location: typeof loc } => ({
      record: { version: 1, serverUrl: 'u', tokens: { access_token: 'a', token_type: 'Bearer', refresh_token: 'r' }, ...over },
      location: loc,
    });
    expect(describeLogin(undefined, 0).state).toBe('not-logged-in');
    expect(describeLogin(rec({ tokens: undefined }), 0).state).toBe('not-logged-in');
    expect(describeLogin(rec({ expiresAt: 5000 }), 1000)).toMatchObject({ state: 'logged-in', expiresAt: 5000 });
    expect(describeLogin(rec({}), 1000).state).toBe('logged-in'); // unknown expiry
    expect(describeLogin(rec({ expiresAt: 500 }), 1000).state).toBe('refreshable');
    expect(describeLogin(rec({ expiresAt: 500, tokens: { access_token: 'a', token_type: 'Bearer' } }), 1000).state).toBe('expired');
    expect(tokenState({ expiresAt: 1000 + 30_000 }, 1000)).toBe('expiring');
    expect(tokenState({ expiresAt: 1000 + 120_000 }, 1000)).toBe('valid');
    expect([formatDuration(5000), formatDuration(54 * 60_000), formatDuration(3 * HOUR), formatDuration(50 * HOUR)]).toEqual(['5s', '54m', '3h', '2d']);
  });
});

describe('token refresh', () => {
  it('concurrent requests share one refresh', async () => {
    const srv = await mockServer();
    const { store, target } = await loggedIn(srv);
    const provider = createCallProvider(httpServer(target.url, { provider: 'linear', auth: { type: 'oauth' } }), store, { now: () => T0 + 2 * HOUR });
    const tokens = await Promise.all(Array.from({ length: 6 }, () => provider.accessToken()));
    expect(new Set(tokens).size).toBe(1);
    expect(srv.state.tokenRequests.filter((t) => t.grant_type === 'refresh_token')).toHaveLength(1);
  });

  it('a process that loses the race to rotate the refresh token picks up the winner\'s tokens', async () => {
    const srv = await mockServer();
    const { store, target } = await loggedIn(srv);
    const config = httpServer(target.url, { provider: 'linear', auth: { type: 'oauth' } });
    const later = () => T0 + 2 * HOUR;
    // Two "processes": separate providers, one shared store, both holding the same stale record.
    const a = createCallProvider(config, store, { now: later });
    const b = createCallProvider(config, store, { now: later });
    await a.load();
    await b.load();
    const [ta, tb] = await Promise.all([a.accessToken(), b.accessToken()]);
    expect(ta).toBeTruthy();
    expect(tb).toBeTruthy();
    expect(srv.state.tokenRequests.filter((t) => t.grant_type === 'refresh_token')).toHaveLength(2);
    // Both ended up with a token the server accepts, and the store holds the winner's login.
    const stored = (await store.get(a.key))!.record.tokens!;
    expect(srv.issuedAccessTokens()).toContain(ta);
    expect(srv.issuedAccessTokens()).toContain(tb);
    expect(srv.issuedRefreshTokens()).toContain(stored.refresh_token);
  });

  it('refreshes ahead of expiry, but keeps working with a still-valid token when the early refresh fails', async () => {
    const srv = await mockServer({ accessTokenTtl: 3600 });
    const { store, target } = await loggedIn(srv);
    const config = httpServer(target.url, { provider: 'linear', auth: { type: 'oauth' } });
    const soon = () => T0 + HOUR - 30_000; // 30s left: inside the skew
    const provider = createCallProvider(config, store, { now: soon });
    srv.state.tokenFailure = 503;
    const original = (await store.get(provider.key))!.record.tokens!.access_token;
    expect(await provider.accessToken()).toBe(original);
    srv.state.tokenFailure = undefined;
    expect(await provider.accessToken()).not.toBe(original);
  });

  it('without a refresh token an expired login is dead', async () => {
    const srv = await mockServer({ refreshTokens: false });
    const { store, target } = await loggedIn(srv);
    const provider = createCallProvider(httpServer(target.url, { provider: 'linear', auth: { type: 'oauth' } }), store, { now: () => T0 + 2 * HOUR });
    await expect(provider.accessToken()).rejects.toMatchObject({ name: 'LoginRequiredError', reason: 'expired' });
  });
});

describe('checkStoreWritable', () => {
  it('names what cannot be written: the file, or the directory it is replaced in', async () => {
    const location = { kind: 'file' as const, path: '/data/via/oauth/oauth-abc.json' };
    const denied = (blocked: string) => async (path: string) => {
      if (path === blocked) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    expect(await checkStoreWritable(location, async () => undefined)).toBeUndefined();
    expect(await checkStoreWritable(location, denied('/data/via/oauth'))).toEqual({ path: '/data/via/oauth', what: 'directory' });
    expect(await checkStoreWritable(location, denied('/data/via/oauth/oauth-abc.json'))).toEqual({ path: '/data/via/oauth/oauth-abc.json', what: 'file' });
  });

  it('does not probe the keychain', async () => {
    expect(await checkStoreWritable({ kind: 'keychain' }, async () => { throw new Error('never called'); })).toBeUndefined();
  });

  it('works on real files', async () => {
    const dir = tmp();
    const file = join(dir, 'x.json');
    writeFileSync(file, '{}');
    expect(await checkStoreWritable({ kind: 'file', path: file })).toBeUndefined();
  });
});

describe('refresh with a read-only token store', () => {
  /** A store that can be read but not written, like a login kept on a read-only mount. */
  function readOnly(inner: ReturnType<typeof createMemoryOAuthStore>) {
    return { get: inner.get.bind(inner), delete: inner.delete.bind(inner), set: async () => { throw new Error('EROFS: read-only file system, open \'/data/via/oauth/x.json\''); } };
  }

  it('keeps working with the refreshed token and warns once per session (not per refresh)', async () => {
    const srv = await mockServer();
    const { store } = await loggedIn(srv);
    let now = T0;
    const warnings: string[] = [];
    const client = new InProcessClient([httpServer(srv.url, { provider: 'linear', name: 'linear', auth: { type: 'oauth' } })], new FakeResolver(), {
      oauthStore: readOnly(store),
      now: () => now,
      onWarning: (m) => warnings.push(m),
    });
    cleanups.push(() => client.close());
    await client.listTools('linear');
    expect(warnings).toEqual([]);
    now = T0 + 2 * HOUR;
    const result = await client.callTool('linear', 'echo_text', { message: 'hi' });
    expect(JSON.stringify(result)).toContain('echo: hi');
    now = T0 + 4 * HOUR;
    await client.callTool('linear', 'echo_text', { message: 'again' });
    expect(srv.state.tokenRequests.filter((t) => t.grant_type === 'refresh_token')).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('linear');
    expect(warnings[0]).toContain('writable');
    expect(warnings[0]).toContain('via doctor');
    // No token value in the warning.
    for (const secret of srv.issuedAccessTokens().concat(srv.issuedRefreshTokens())) expect(warnings[0]).not.toContain(secret);
  });

  it('delivers the warning to the call that caused it (what the daemon forwards to its caller)', async () => {
    const srv = await mockServer();
    const { store } = await loggedIn(srv);
    let now = T0;
    const client = new InProcessClient([httpServer(srv.url, { provider: 'linear', name: 'linear', auth: { type: 'oauth' } })], new FakeResolver(), { oauthStore: readOnly(store), now: () => now });
    cleanups.push(() => client.close());
    await client.listTools('linear');
    now = T0 + 2 * HOUR;
    const warnings: string[] = [];
    await client.callTool('linear', 'echo_text', { message: 'hi' }, { onWarning: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
  });

  it('a writable store produces no warning', async () => {
    const srv = await mockServer();
    const { store } = await loggedIn(srv);
    let now = T0;
    const warnings: string[] = [];
    const client = new InProcessClient([httpServer(srv.url, { provider: 'linear', name: 'linear', auth: { type: 'oauth' } })], new FakeResolver(), { oauthStore: store, now: () => now, onWarning: (m) => warnings.push(m) });
    cleanups.push(() => client.close());
    await client.listTools('linear');
    now = T0 + 2 * HOUR;
    await client.callTool('linear', 'echo_text', { message: 'hi' });
    expect(warnings).toEqual([]);
  });
});

describe('InProcessClient with OAuth', () => {
  it('lists tools and calls after login, and registers the tokens for redaction', async () => {
    const srv = await mockServer();
    const { store } = await loggedIn(srv);
    const resolver = new FakeResolver() as FakeResolver & { track: (v: string) => void };
    const tracked: string[] = [];
    resolver.track = (v) => tracked.push(v);
    const client = new InProcessClient([httpServer(srv.url, { provider: 'linear', name: 'linear', auth: { type: 'oauth' } })], resolver, { oauthStore: store, now: () => T0 });
    cleanups.push(() => client.close());
    const tools = await client.listTools('linear');
    expect(tools.some((t) => t.name === 'whoami')).toBe(true);
    const result = await client.callTool('linear', 'echo_text', { message: 'hi' });
    expect(JSON.stringify(result)).toContain('echo: hi');
    expect(tracked).toContain((await store.get(oauthKey({ url: srv.url })))!.record.tokens!.access_token);
  });

  it('without a login fails with exit 4 before sending anything', async () => {
    const srv = await mockServer();
    const client = new InProcessClient([httpServer(srv.url, { provider: 'linear', name: 'linear', auth: { type: 'oauth' } })], new FakeResolver(), { oauthStore: createMemoryOAuthStore() });
    await expect(client.listTools('linear')).rejects.toMatchObject({ exitCode: 4, message: 'linear requires auth', next: 'via auth login linear' });
    expect(srv.state.mcp).toHaveLength(0);
  });

  it('a stdio server cannot use OAuth', async () => {
    const client = new InProcessClient([{ ...httpServer('http://x/mcp'), transport: { type: 'stdio', command: 'node', args: [], env: {} }, auth: { type: 'oauth' } }], new FakeResolver(), { oauthStore: createMemoryOAuthStore() });
    await expect(client.listTools('mock')).rejects.toMatchObject({ exitCode: 2 });
  });

  it('a session keeps refreshing for as long as it lives (what a daemon holds)', async () => {
    const srv = await mockServer();
    const { store } = await loggedIn(srv);
    let now = T0;
    const client = new InProcessClient([httpServer(srv.url, { provider: 'linear', name: 'linear', auth: { type: 'oauth' } })], new FakeResolver(), { oauthStore: store, now: () => now });
    cleanups.push(() => client.close());
    await client.listTools('linear');
    expect(srv.state.tokenRequests.filter((t) => t.grant_type === 'refresh_token')).toHaveLength(0);
    now = T0 + 2 * HOUR; // same connected session, token ran out meanwhile
    await client.callTool('linear', 'echo_text', { message: 'again' });
    now = T0 + 4 * HOUR;
    await client.callTool('linear', 'echo_text', { message: 'and again' });
    expect(srv.state.tokenRequests.filter((t) => t.grant_type === 'refresh_token')).toHaveLength(2);
  });
});
