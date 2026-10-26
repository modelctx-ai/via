import { createServer, type Server } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { InProcessClient } from '../../src/client';
import {
  CALLBACK_PORTS,
  CLIENT_METADATA_URL,
  CallbackPortsBusyError,
  accountOf,
  browserUnavailable,
  checkStoreWritable,
  createCallProvider,
  createMemoryOAuthStore,
  createOAuthStore,
  describeLogin,
  documentedRedirectUris,
  formatDuration,
  oauthKey,
  oauthTarget,
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
import { startOAuthServer, type OAuthServer, type OAuthServerOptions } from '../fixtures/mcp/oauth-server.mjs';
import { FakeResolver, httpServer } from '../helpers/client';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function mockServer(options: OAuthServerOptions = {}): Promise<OAuthServer> {
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

  it('splits a record over several Credential Manager entries on Windows, where one holds about 1280 characters', async () => {
    const limited = fakeKeyring();
    const entry = limited.AsyncEntry;
    const writes: number[] = [];
    // Credential Manager: a password longer than 1280 UTF-16 characters is refused.
    limited.AsyncEntry = class extends entry {
      override async setPassword(value: string) {
        writes.push(value.length);
        if (value.length > 1280) throw new Error('Attribute password is longer than platform limit of 1280 chars');
        return super.setPassword(value);
      }
    };
    const big: OAuthRecord = { ...record, tokens: { access_token: `${'a'.repeat(2500)}😀${'b'.repeat(1500)}`, token_type: 'Bearer', refresh_token: 'r'.repeat(900) } };
    const key = oauthKey({ url: record.serverUrl });

    const win = createOAuthStore({ dir: join(tmp(), 'oauth'), mode: 'keychain', platform: 'win32', loadKeyring: async () => limited });
    expect(await win.set(key, big)).toEqual({ location: { kind: 'keychain' } });
    expect(Math.max(...writes)).toBeLessThanOrEqual(1280);
    expect(limited.data[key]).toMatch(/^via:chunks:\d+$/);
    expect(Object.keys(limited.data).length).toBeGreaterThan(2);
    expect((await win.get(key))?.record).toEqual(big);

    // A shorter record afterwards leaves no stale pieces behind, and a small one stays in one entry.
    await win.set(key, record);
    expect(Object.keys(limited.data)).toEqual([key]);
    expect(JSON.parse(limited.data[key]!)).toEqual(record);

    await win.set(key, big);
    expect(await win.delete(key)).toBe(true);
    expect(limited.data).toEqual({});
    expect(await win.get(key)).toBeUndefined();

    // Elsewhere nothing is split: the platform decides what it accepts.
    const posix = createOAuthStore({ dir: join(tmp(), 'oauth'), mode: 'keychain', platform: 'linux', loadKeyring: async () => limited });
    await expect(posix.set(key, big)).rejects.toThrow('longer than platform limit');
  });

  it('treats a split record with a missing piece as no login', async () => {
    const keyring = fakeKeyring({ 'oauth:k': 'via:chunks:3', 'oauth:k#0': '{"ver', 'oauth:k#1': 'sion":1' });
    const store = createOAuthStore({ dir: join(tmp(), 'oauth'), mode: 'keychain', platform: 'win32', loadKeyring: async () => keyring });
    expect(await store.get('oauth:k')).toBeUndefined();
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
    // Windows has no mode bits; the file sits in the user's profile and is protected by its ACL.
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
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

/** Occupy `port` on 127.0.0.1 for the length of the test. */
function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      cleanups.push(() => new Promise<void>((ok) => server.close(() => ok())));
      resolve(server);
    });
  });
}

describe('callback ports', () => {
  it('are ten fixed loopback ports below every ephemeral range, and the metadata document lists exactly those redirect URIs', () => {
    expect(CALLBACK_PORTS).toHaveLength(10);
    expect(CALLBACK_PORTS.every((port, i) => port === CALLBACK_PORTS[0]! + i)).toBe(true);
    expect(Math.max(...CALLBACK_PORTS)).toBeLessThan(32768);
    const doc = JSON.parse(readFileSync(new URL('../../pages/client-metadata.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    expect(doc.client_id).toBe(CLIENT_METADATA_URL);
    expect(doc.redirect_uris).toEqual(documentedRedirectUris());
    expect(documentedRedirectUris().every((u) => u.startsWith('http://127.0.0.1:') && u.endsWith('/callback'))).toBe(true);
    expect(doc).toMatchObject({ client_name: 'via', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    expect(new URL(CLIENT_METADATA_URL).protocol).toBe('https:');
  });

  it('the listener takes the first free port of the range and moves on when one is taken', async () => {
    const ports = [29880, 29881, 29882]; // outside the real range: other test files log in concurrently
    const taken = await occupy(ports[0]!);
    const loop = await startLoopback(ports);
    cleanups.push(() => loop.close());
    expect(loop.redirectUrl).toBe('http://127.0.0.1:29881/callback');
    expect(taken.listening).toBe(true);
  });

  it('is an error naming the range when every port is taken', async () => {
    const ports = [29860, 29861];
    for (const port of ports) await occupy(port);
    await expect(startLoopback(ports)).rejects.toBeInstanceOf(CallbackPortsBusyError);
    await expect(startLoopback(ports)).rejects.toThrow('ports 29860-29861 on 127.0.0.1 are all in use');
  });

  it('a login with every port taken fails with exit 6 and suggests --manual', async () => {
    const srv = await mockServer();
    const ports = [29862, 29863];
    for (const port of ports) await occupy(port);
    const error = await performLogin({ target: { provider: 'linear', url: srv.url }, store: createMemoryOAuthStore(), manual: false, timeoutMs: 2000, io: io(srv), callbackPorts: ports }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'LoginFailedError', exitCode: 6, next: 'via auth login linear --manual' });
    expect((error as Error).message).toBe('linear: ports 29862-29863 on 127.0.0.1 are all in use');
    expect(srv.state.registrations).toHaveLength(0);
  });

  it('--manual uses the first port of the range as redirect URI without listening on it', async () => {
    const srv = await mockServer();
    const urls: string[] = [];
    const manual: LoginIO = { ...io(srv), showUrl: (url) => urls.push(url), readLine: async () => (await srv.approve(urls[0]!)) };
    await performLogin({ target: { provider: 'linear', url: srv.url }, store: createMemoryOAuthStore(), manual: true, timeoutMs: 5000, io: manual, callbackPorts: [29870, 29871] });
    expect(srv.state.registrations[0]?.redirect_uris).toEqual(['http://127.0.0.1:29870/callback']);
  });
});

describe('client ID metadata document (CIMD)', () => {
  const document = (): Record<string, unknown> => JSON.parse(readFileSync(new URL('../../pages/client-metadata.json', import.meta.url), 'utf8')) as Record<string, unknown>;

  it('is the client id where the authorization server supports it: no registration, public client, loopback from the documented range', async () => {
    const srv = await mockServer({ cimd: { [CLIENT_METADATA_URL]: document() } });
    const notes: string[] = [];
    const store = createMemoryOAuthStore();
    const target = { provider: 'linear', url: srv.url, clientMetadataUrl: CLIENT_METADATA_URL };
    const { record } = await performLogin({ target, store, manual: false, timeoutMs: 10_000, io: { ...io(srv), note: (t) => notes.push(t) }, now: () => T0 });
    expect(srv.state.registrations).toHaveLength(0);
    expect(srv.state.authorizeRequests[0]).toMatchObject({ client_id: CLIENT_METADATA_URL });
    expect(documentedRedirectUris()).toContain(srv.state.authorizeRequests[0]!.redirect_uri);
    expect(srv.state.tokenRequests[0]).toMatchObject({ client_id: CLIENT_METADATA_URL, grant_type: 'authorization_code' });
    expect(srv.state.tokenRequests[0]).not.toHaveProperty('client_secret');
    expect(record.clientInformation).toMatchObject({ client_id: CLIENT_METADATA_URL });
    expect(notes.some((n) => n.startsWith(`client id: ${CLIENT_METADATA_URL} (client ID metadata document`))).toBe(true);

    // The login refreshes with the same client id.
    srv.expireAccessTokens();
    const provider = createCallProvider({ ...httpServer(srv.url, { provider: 'linear', name: 'linear', auth: { type: 'oauth' } }) }, store, { now: () => T0 + 2 * HOUR });
    await provider.accessToken();
    expect(srv.state.tokenRequests.at(-1)).toMatchObject({ grant_type: 'refresh_token', client_id: CLIENT_METADATA_URL });
  });

  it('is not used when the authorization server does not advertise it: dynamic registration', async () => {
    const srv = await mockServer();
    await performLogin({ target: { provider: 'linear', url: srv.url, clientMetadataUrl: CLIENT_METADATA_URL }, store: createMemoryOAuthStore(), manual: false, timeoutMs: 10_000, io: io(srv), now: () => T0 });
    expect(srv.state.registrations).toHaveLength(1);
    expect(srv.state.authorizeRequests[0]!.client_id).not.toBe(CLIENT_METADATA_URL);
  });

  it('is not used when it is turned off, or when a clientId is configured', async () => {
    const srv = await mockServer({ cimd: { [CLIENT_METADATA_URL]: document() } });
    await performLogin({ target: { provider: 'linear', url: srv.url }, store: createMemoryOAuthStore(), manual: false, timeoutMs: 10_000, io: io(srv), now: () => T0 });
    expect(srv.state.registrations).toHaveLength(1);
    // The fixture does not know this id; the point is which one is sent.
    const error = await performLogin({ target: { provider: 'linear', url: srv.url, clientId: 'pre-registered', clientMetadataUrl: CLIENT_METADATA_URL }, store: createMemoryOAuthStore(), manual: false, timeoutMs: 1000, io: io(srv), now: () => T0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(srv.state.authorizeRequests.at(-1)).toMatchObject({ client_id: 'pre-registered' });
    expect(srv.state.registrations).toHaveLength(1);
  });

  it('a configured URL replaces the hosted document; false switches CIMD off (oauthTarget)', () => {
    const server = (oauth: object) => httpServer('https://m.example/mcp', { provider: 'm', name: 'm', auth: { type: 'oauth', ...oauth } as never });
    expect(oauthTarget(server({}))?.clientMetadataUrl).toBe(CLIENT_METADATA_URL);
    expect(oauthTarget(server({ clientMetadataUrl: 'https://example.org/c.json' }))?.clientMetadataUrl).toBe('https://example.org/c.json');
    expect(oauthTarget(server({ clientMetadataUrl: false }))).not.toHaveProperty('clientMetadataUrl');
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
  });

  it('opens a URL on Windows without cmd.exe: the URL is an argument of rundll32 and no shell sees it', () => {
    const hostile = 'https://a/b?c=1&d=2|calc^(%PATH%)';
    expect(openerCommand(hostile, 'win32', { SystemRoot: 'C:\\Windows' })).toEqual({
      command: 'C:\\Windows\\System32\\rundll32.exe',
      args: ['url.dll,FileProtocolHandler', hostile],
    });
    expect(openerCommand(hostile, 'win32', {}).command).toBe('rundll32.exe');
  });

  it('opens web pages only', async () => {
    for (const url of ['file:///C:/Windows/System32/calc.exe', 'C:\\Windows\\System32\\calc.exe', 'ms-settings:', 'javascript:alert(1)']) {
      expect(await openBrowser(url, { DISPLAY: ':0' }, 'linux')).toEqual({ opened: false, reason: 'the URL is not an http(s) URL' });
    }
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
    await expect(client.listTools('linear')).rejects.toMatchObject({ exitCode: 4, message: 'linear requires auth', next: 'ask the user to run this in a terminal: via auth login linear' });
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

// Client secrets, the machine grant and the binding to the authorization server (auth.md) -----------------------

const SECRET = 'shh-this-is-the-client-secret';

type MemoryStore = ReturnType<typeof createMemoryOAuthStore>;

/** A credential resolver for `env:` references that records what it handed out, like the real one. */
function secrets(values: Record<string, string>): { resolve: (ref: string) => Promise<string>; handedOut: string[] } {
  const handedOut: string[] = [];
  return {
    handedOut,
    resolve: async (ref) => {
      const value = values[ref.replace(/^env:/, '')];
      if (value === undefined) throw new Error(`no such credential ${ref}`);
      handedOut.push(value);
      return value;
    },
  };
}

function machineServer(url: string, oauth: Record<string, unknown> = {}) {
  return httpServer(url, { provider: 'ci', name: 'ci', auth: { type: 'oauth', grant: 'client_credentials', clientId: 'ci-client', clientSecret: 'env:CI_SECRET', ...oauth } as never });
}

describe('a pre-registered client with a secret', () => {
  it('authenticates at the token endpoint with the secret (login and refresh), and the secret is not kept in the record', async () => {
    const srv = await mockServer({ dcr: false, preRegistered: { clientId: 'pre', clientSecret: SECRET } });
    const store = createMemoryOAuthStore();
    const { resolve, handedOut } = secrets({ PRE_SECRET: SECRET });
    const target = { provider: 'linear', url: srv.url, clientId: 'pre', clientSecret: 'env:PRE_SECRET' };
    const { record } = await performLogin({ target, store, manual: false, timeoutMs: 10_000, io: io(srv), credentials: resolve, now: () => T0 });
    expect(srv.state.tokenAuth).toEqual([{ grantType: 'authorization_code', clientId: 'pre', method: 'basic' }]);
    expect(srv.state.registrations).toHaveLength(0);
    expect(handedOut).toContain(SECRET);
    expect(JSON.stringify(record)).not.toContain(SECRET);
    expect(JSON.stringify([...store.records.values()])).not.toContain(SECRET);

    const server = httpServer(srv.url, { provider: 'linear', name: 'linear', auth: { type: 'oauth', clientId: 'pre', clientSecret: 'env:PRE_SECRET' } });
    const provider = createCallProvider(server, store, { resolveCredential: resolve, now: () => T0 + 2 * HOUR });
    await provider.accessToken();
    expect(srv.state.tokenAuth.at(-1)).toEqual({ grantType: 'refresh_token', clientId: 'pre', method: 'basic' });
  });

  it('a wrong secret is refused by the server and nothing is stored', async () => {
    const srv = await mockServer({ dcr: false, preRegistered: { clientId: 'pre', clientSecret: SECRET } });
    const store = createMemoryOAuthStore();
    const target = { provider: 'linear', url: srv.url, clientId: 'pre', clientSecret: 'env:X' };
    const error = await performLogin({ target, store, manual: false, timeoutMs: 10_000, io: io(srv), credentials: async () => 'not-the-secret', now: () => T0 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'LoginFailedError', exitCode: 4 });
    expect(store.records.size).toBe(0);
  });
});

describe('client credentials (machine grant)', () => {
  it('asks for a token with the secret when none is saved, saves it, and reuses it until it runs out', async () => {
    const srv = await mockServer({ machine: { clientId: 'ci-client', clientSecret: SECRET } });
    const store = createMemoryOAuthStore();
    const { resolve, handedOut } = secrets({ CI_SECRET: SECRET });
    let now = T0;
    const provider = createCallProvider(machineServer(srv.url), store, { resolveCredential: resolve, now: () => now });
    await provider.requireLogin(); // no login needed
    const token = await provider.accessToken();
    expect(token).toMatch(/^cc-/);
    expect(srv.state.tokenAuth).toEqual([{ grantType: 'client_credentials', clientId: 'ci-client', method: 'basic' }]);
    expect(srv.state.tokenRequests[0]).toMatchObject({ grant_type: 'client_credentials', resource: srv.url });
    expect(handedOut).toContain(SECRET);

    const saved = [...store.records.values()][0]!;
    expect(saved).toMatchObject({ grant: 'client_credentials', issuer: srv.issuer, tokens: { access_token: token } });
    expect(saved.tokens).not.toHaveProperty('refresh_token');
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    // The machine grant has a record of its own: the authorization code login of the same endpoint is another one.
    expect(oauthKey({ url: srv.url, clientId: 'ci-client', grant: 'client_credentials' })).not.toBe(oauthKey({ url: srv.url, clientId: 'ci-client' }));

    // A second process finds the token.
    const other = createCallProvider(machineServer(srv.url), store, { resolveCredential: resolve, now: () => now });
    expect(await other.accessToken()).toBe(token);
    expect(srv.state.tokenAuth).toHaveLength(1);

    // It runs out: asked again, no refresh grant.
    now = T0 + 2 * HOUR;
    const next = await provider.accessToken();
    expect(next).not.toBe(token);
    expect(srv.state.tokenAuth.map((t) => t.grantType)).toEqual(['client_credentials', 'client_credentials']);
  });

  it('asks again when the server refuses the saved token', async () => {
    const srv = await mockServer({ machine: { clientId: 'ci-client', clientSecret: SECRET } });
    const client = new InProcessClient([machineServer(srv.url)], new FakeResolver({ CI_SECRET: SECRET }), { oauthStore: createMemoryOAuthStore(), now: () => T0 });
    cleanups.push(() => client.close());
    // No login was made: the first use asks for the token.
    await client.listTools('ci');
    expect(srv.state.tokenAuth).toHaveLength(1);
    srv.expireAccessTokens();
    const result = await client.callTool('ci', 'echo_text', { message: 'hi' });
    expect(JSON.stringify(result)).toContain('echo: hi');
    expect(srv.state.tokenAuth).toHaveLength(2);
  });

  it('signs a client assertion when a private key is configured (private_key_jwt)', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const srv = await mockServer({ machine: { clientId: 'ci-client', publicKey } });
    const { resolve } = secrets({ CI_KEY: pem });
    const server = httpServer(srv.url, { provider: 'ci', name: 'ci', auth: { type: 'oauth', grant: 'client_credentials', clientId: 'ci-client', privateKey: 'env:CI_KEY', keyAlgorithm: 'ES256' } });
    const provider = createCallProvider(server, createMemoryOAuthStore(), { resolveCredential: resolve, now: () => T0 });
    expect(await provider.accessToken()).toMatch(/^cc-/);
    expect(srv.state.tokenAuth.map((t) => t.method)).toEqual(['jwt']);
    expect(srv.state.tokenRequests[0]).toMatchObject({ client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' });
    expect(JSON.stringify(srv.state.tokenRequests)).not.toContain('PRIVATE KEY');
  });

  it('a refused secret is a client-credentials error (exit 4) that never shows the secret', async () => {
    const srv = await mockServer({ machine: { clientId: 'ci-client', clientSecret: SECRET } });
    const provider = createCallProvider(machineServer(srv.url), createMemoryOAuthStore(), { resolveCredential: async () => 'wrong-secret-value', now: () => T0 });
    const error = await provider.accessToken().catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ClientCredentialsRejectedError', code: 'invalid_client' });
    expect((error as Error).message).not.toContain('wrong-secret-value');
    const client = new InProcessClient([machineServer(srv.url)], new FakeResolver({ CI_SECRET: 'wrong-secret-value' }), { oauthStore: createMemoryOAuthStore(), now: () => T0 });
    cleanups.push(() => client.close());
    await expect(client.listTools('ci')).rejects.toMatchObject({ exitCode: 4, message: 'ci: the authorization server refused the client credentials (invalid_client)' });
  });

  it('a credential that does not resolve fails before anything is sent (exit 4)', async () => {
    const srv = await mockServer({ machine: { clientId: 'ci-client', clientSecret: SECRET } });
    const client = new InProcessClient([machineServer(srv.url)], new FakeResolver({}), { oauthStore: createMemoryOAuthStore(), now: () => T0 });
    await expect(client.listTools('ci')).rejects.toMatchObject({ exitCode: 4, next: 'export CI_SECRET=<value>' });
    expect(srv.state.tokenAuth).toHaveLength(0);
    expect(srv.state.mcp).toHaveLength(0);
  });

  it('login validates the credentials, discovering the authorization server through the protected resource metadata', async () => {
    const srv = await mockServer({ machine: { clientId: 'ci-client', clientSecret: SECRET }, scopes: ['read', 'write'] });
    const store = createMemoryOAuthStore();
    const { resolve } = secrets({ CI_SECRET: SECRET });
    const target = { provider: 'ci', url: srv.url, clientId: 'ci-client', grant: 'client_credentials' as const, clientSecret: 'env:CI_SECRET', scopes: ['read'] };
    const noBrowser: LoginIO = {
      ...io(srv),
      openUrl: async () => {
        throw new Error('the machine grant opens no browser');
      },
    };
    const { record, set } = await performLogin({ target, store, manual: false, timeoutMs: 5000, io: noBrowser, credentials: resolve, now: () => T0 });
    expect(record).toMatchObject({ grant: 'client_credentials', scope: 'read', issuer: srv.issuer });
    expect(set.location.kind).toBe('file');
    expect(srv.state.tokenRequests[0]).toMatchObject({ scope: 'read' });
    expect(srv.state.authorizeRequests).toHaveLength(0);
    expect(srv.state.registrations).toHaveLength(0);
  });
});

describe('binding stored credentials to the authorization server', () => {
  it('a server that now points at another authorization server does not get the machine grant credentials', async () => {
    const a = await mockServer({ machine: { clientId: 'ci-client', clientSecret: SECRET } });
    const b = await mockServer({ machine: { clientId: 'ci-client', clientSecret: SECRET } });
    const store = createMemoryOAuthStore();
    const { resolve } = secrets({ CI_SECRET: SECRET });
    const target = { provider: 'ci', url: a.url, clientId: 'ci-client', grant: 'client_credentials' as const, clientSecret: 'env:CI_SECRET' };
    await performLogin({ target, store, manual: false, timeoutMs: 5000, io: io(a), credentials: resolve, now: () => T0 });
    expect(a.state.tokenAuth).toHaveLength(1);

    a.state.authorizationServers = [b.issuer];
    // The login rediscovers, finds the other server and refuses.
    const again = await performLogin({ target, store, manual: false, timeoutMs: 5000, io: io(a), credentials: resolve, now: () => T0 }).catch((e: unknown) => e);
    expect(again).toMatchObject({ name: 'LoginFailedError', exitCode: 4, next: 'via auth logout ci' });
    expect((again as Error).message).toBe(`ci: its authorization server changed from ${a.issuer} to ${b.issuer}; the saved client credentials belong to the first and were not sent to the second`);
    expect(b.state.tokenAuth).toHaveLength(0);
    expect(b.state.tokenRequests).toHaveLength(0);

    // A call that has to discover again (the cached discovery is gone) refuses the same way.
    const [key, saved] = [...store.records.entries()][0]!;
    delete saved.discovery;
    delete saved.tokens;
    store.records.set(key, saved);
    const provider = createCallProvider(machineServer(a.url), store, { resolveCredential: resolve, now: () => T0 });
    await expect(provider.accessToken()).rejects.toMatchObject({ name: 'AuthorizationServerChangedError', recorded: a.issuer, current: b.issuer });
    expect(b.state.tokenAuth).toHaveLength(0);
    const client = new InProcessClient([machineServer(a.url)], new FakeResolver({ CI_SECRET: SECRET }), { oauthStore: store, now: () => T0 });
    cleanups.push(() => client.close());
    await expect(client.listTools('ci')).rejects.toMatchObject({ exitCode: 4, next: 'via auth logout ci' });
    expect(b.state.tokenAuth).toHaveLength(0);

    // After a logout the credentials may be validated against the new server.
    await store.delete(key);
    const fresh = await performLogin({ target, store, manual: false, timeoutMs: 5000, io: io(a), credentials: resolve, now: () => T0 });
    expect(fresh.record.issuer).toBe(b.issuer);
  });

  it('a configured secret is not sent to another authorization server at the next login', async () => {
    const a = await mockServer({ dcr: false, preRegistered: { clientId: 'pre', clientSecret: SECRET } });
    const b = await mockServer({ dcr: false, preRegistered: { clientId: 'pre', clientSecret: SECRET } });
    const store = createMemoryOAuthStore();
    const { resolve } = secrets({ PRE_SECRET: SECRET });
    const target = { provider: 'linear', url: a.url, clientId: 'pre', clientSecret: 'env:PRE_SECRET' };
    await performLogin({ target, store, manual: false, timeoutMs: 10_000, io: io(a), credentials: resolve, now: () => T0 });
    a.state.authorizationServers = [b.issuer];
    const error = await performLogin({ target, store, manual: false, timeoutMs: 2000, io: io(b), credentials: resolve, now: () => T0 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'LoginFailedError', exitCode: 4, next: 'via auth logout linear' });
    expect(b.state.authorizeRequests).toHaveLength(0);
    expect(b.state.tokenAuth).toHaveLength(0);
  });

  it('a refresh token and a dynamically registered client go only to the authorization server that issued them', async () => {
    const a = await mockServer();
    const b = await mockServer();
    const { store } = await loggedIn(a);
    const memory = store as MemoryStore;
    const [key, saved] = [...memory.records.entries()][0]!;
    expect(saved.issuer).toBe(a.issuer);
    delete saved.discovery; // as in a record from before the discovery cache existed
    memory.records.set(key, saved);
    a.state.authorizationServers = [b.issuer];
    const server = httpServer(a.url, { provider: 'linear', name: 'linear', auth: { type: 'oauth' } });
    const provider = createCallProvider(server, store, { now: () => T0 + 2 * HOUR });
    await expect(provider.accessToken()).rejects.toMatchObject({ name: 'AuthorizationServerChangedError', recorded: a.issuer, current: b.issuer });
    expect(b.state.tokenRequests).toHaveLength(0);
    // The login was not dropped: pointing back at the right server makes it work again.
    a.state.authorizationServers = undefined;
    const back = createCallProvider(server, store, { now: () => T0 + 2 * HOUR });
    expect(await back.accessToken()).toMatch(/^at-/);
  });

  it('a record from before binding adopts the authorization server it meets, and keeps it from then on', async () => {
    const a = await mockServer();
    const { store } = await loggedIn(a);
    const memory = store as MemoryStore;
    const [key, saved] = [...memory.records.entries()][0]!;
    delete saved.issuer;
    delete (saved.clientInformation as { issuer?: string }).issuer;
    delete (saved.tokens as { issuer?: string }).issuer;
    memory.records.set(key, saved);
    const server = httpServer(a.url, { provider: 'linear', name: 'linear', auth: { type: 'oauth' } });
    await createCallProvider(server, store, { now: () => T0 + 2 * HOUR }).accessToken();
    expect(memory.records.get(key)?.issuer).toBe(a.issuer);
  });
});

describe('pinning the authorization server (auth.oauth.issuer)', () => {
  const WRONG = 'https://other-as.example.invalid';
  const pinnedServer = (url: string, issuer: string) => httpServer(url, { provider: 'linear', name: 'linear', auth: { type: 'oauth', issuer } as never });

  it('reaches the login and the provider through oauthTarget', () => {
    expect(oauthTarget(pinnedServer('https://m.example/mcp', WRONG))?.issuer).toBe(WRONG);
    expect(oauthTarget(httpServer('https://m.example/mcp', { provider: 'm', name: 'm', auth: { type: 'oauth' } }))).not.toHaveProperty('issuer');
  });

  it('refuses an authorization server other than the pinned one before registering or authorizing (authorization code login)', async () => {
    const srv = await mockServer();
    const store = createMemoryOAuthStore();
    const target = { provider: 'linear', url: srv.url, issuer: WRONG };
    const error = await performLogin({ target, store, manual: false, timeoutMs: 2000, io: io(srv), now: () => T0 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'LoginFailedError', exitCode: 4, next: 'check auth.oauth.issuer of linear in your via config' });
    expect((error as Error).message).toBe(`linear: its authorization server is ${srv.issuer}, not ${WRONG} as pinned by auth.oauth.issuer; nothing was sent to it`);
    expect(srv.state.registrations).toHaveLength(0);
    expect(srv.state.authorizeRequests).toHaveLength(0);
    expect(srv.state.tokenRequests).toHaveLength(0);
    expect(store.records.size).toBe(0);
  });

  it('accepts the pinned authorization server, with or without a trailing slash (authorization code login, then calls)', async () => {
    const srv = await mockServer();
    for (const issuer of [srv.issuer, `${srv.issuer}/`]) {
      const store = createMemoryOAuthStore();
      const result = await performLogin({ target: { provider: 'linear', url: srv.url, issuer }, store, manual: false, timeoutMs: 10_000, io: io(srv), now: () => T0 });
      expect(result.record.issuer).toBe(srv.issuer);
      const provider = createCallProvider(pinnedServer(srv.url, issuer), store, { now: () => T0 + 2 * HOUR });
      expect(await provider.accessToken()).toMatch(/^at-/); // refreshed at the pinned server
    }
  });

  it('compares exactly apart from the trailing slash: no case folding or other normalization of the pin', async () => {
    const srv = await mockServer();
    const upper = srv.issuer.replace('http://', 'HTTP://');
    const error = await performLogin({ target: { provider: 'linear', url: srv.url, issuer: upper }, store: createMemoryOAuthStore(), manual: false, timeoutMs: 2000, io: io(srv), now: () => T0 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'LoginFailedError', exitCode: 4 });
  });

  it('a refresh goes only to the pinned authorization server, and a login from another one is not used', async () => {
    const srv = await mockServer();
    const { store } = await loggedIn(srv);
    const tokens = srv.state.tokenRequests.length;
    // Pinned to the server that issued the login: refreshes as before.
    expect(await createCallProvider(pinnedServer(srv.url, srv.issuer), store, { now: () => T0 + 2 * HOUR }).accessToken()).toMatch(/^at-/);
    expect(srv.state.tokenRequests.length).toBe(tokens + 1);
    // Pinned to another one (set after the login): the saved login and its refresh token stay where they are.
    const provider = createCallProvider(pinnedServer(srv.url, WRONG), store, { now: () => T0 + 4 * HOUR });
    await expect(provider.accessToken()).rejects.toMatchObject({ name: 'PinnedIssuerMismatchError', pinned: WRONG, actual: srv.issuer, savedLogin: true });
    expect(srv.state.tokenRequests.length).toBe(tokens + 1);
    // Not even a still-valid access token is used.
    const valid = createCallProvider(pinnedServer(srv.url, WRONG), store, { now: () => T0 + 2 * HOUR });
    await expect(valid.accessToken()).rejects.toMatchObject({ name: 'PinnedIssuerMismatchError' });
    const client = new InProcessClient([pinnedServer(srv.url, WRONG)], new FakeResolver({}), { oauthStore: store, now: () => T0 });
    cleanups.push(() => client.close());
    await expect(client.listTools('linear')).rejects.toMatchObject({ exitCode: 4, next: 'via auth logout linear' });
  });

  it('a refresh that has to rediscover refuses a server that now names another authorization server', async () => {
    const a = await mockServer();
    const b = await mockServer();
    const { store } = await loggedIn(a);
    const memory = store as MemoryStore;
    const [key, saved] = [...memory.records.entries()][0]!;
    delete saved.discovery;
    memory.records.set(key, saved);
    a.state.authorizationServers = [b.issuer];
    const provider = createCallProvider(pinnedServer(a.url, a.issuer), store, { now: () => T0 + 2 * HOUR });
    // The record says "a" and so does the pin: the refusal is the pin's, not the binding's.
    await expect(provider.accessToken()).rejects.toMatchObject({ name: 'PinnedIssuerMismatchError', pinned: a.issuer, actual: b.issuer });
    expect(b.state.tokenRequests).toHaveLength(0);
  });

  describe('client credentials', () => {
    const machine = (url: string, issuer: string) => machineServer(url, { issuer });

    it('login refuses another authorization server before any credential is sent', async () => {
      const srv = await mockServer({ machine: { clientId: 'ci-client', clientSecret: SECRET } });
      const { resolve } = secrets({ CI_SECRET: SECRET });
      const target = { provider: 'ci', url: srv.url, clientId: 'ci-client', grant: 'client_credentials' as const, clientSecret: 'env:CI_SECRET', issuer: WRONG };
      const error = await performLogin({ target, store: createMemoryOAuthStore(), manual: false, timeoutMs: 5000, io: io(srv), credentials: resolve, now: () => T0 }).catch((e: unknown) => e);
      expect(error).toMatchObject({ name: 'LoginFailedError', exitCode: 4, next: 'check auth.oauth.issuer of ci in your via config' });
      expect((error as Error).message).toBe(`ci: its authorization server is ${srv.issuer}, not ${WRONG} as pinned by auth.oauth.issuer; nothing was sent to it`);
      expect(srv.state.tokenAuth).toHaveLength(0);
      expect(srv.state.tokenRequests).toHaveLength(0);
    });

    it('a call refuses another authorization server before any credential is sent, and works with the right pin', async () => {
      const srv = await mockServer({ machine: { clientId: 'ci-client', clientSecret: SECRET } });
      const store = createMemoryOAuthStore();
      const { resolve } = secrets({ CI_SECRET: SECRET });
      const wrong = createCallProvider(machine(srv.url, WRONG), store, { resolveCredential: resolve, now: () => T0 });
      await expect(wrong.accessToken()).rejects.toMatchObject({ name: 'PinnedIssuerMismatchError', pinned: WRONG, actual: srv.issuer });
      expect(srv.state.tokenAuth).toHaveLength(0);
      const client = new InProcessClient([machine(srv.url, WRONG)], new FakeResolver({ CI_SECRET: SECRET }), { oauthStore: store, now: () => T0 });
      cleanups.push(() => client.close());
      await expect(client.listTools('ci')).rejects.toMatchObject({ exitCode: 4, next: 'check auth.oauth.issuer of ci in your via config' });
      expect(srv.state.tokenAuth).toHaveLength(0);

      const right = createCallProvider(machine(srv.url, `${srv.issuer}/`), store, { resolveCredential: resolve, now: () => T0 });
      expect(await right.accessToken()).toMatch(/^cc-/);
      expect(srv.state.tokenAuth).toHaveLength(1);
      // The saved token was issued by the pinned server; pinning another one afterwards stops it being used.
      await expect(createCallProvider(machine(srv.url, WRONG), store, { resolveCredential: resolve, now: () => T0 }).accessToken()).rejects.toMatchObject({ name: 'PinnedIssuerMismatchError', savedLogin: true });
      expect(srv.state.tokenAuth).toHaveLength(1);
    });

    it('login accepts the pinned authorization server', async () => {
      const srv = await mockServer({ machine: { clientId: 'ci-client', clientSecret: SECRET } });
      const { resolve } = secrets({ CI_SECRET: SECRET });
      const target = { provider: 'ci', url: srv.url, clientId: 'ci-client', grant: 'client_credentials' as const, clientSecret: 'env:CI_SECRET', issuer: srv.issuer };
      const result = await performLogin({ target, store: createMemoryOAuthStore(), manual: false, timeoutMs: 5000, io: io(srv), credentials: resolve, now: () => T0 });
      expect(result.record.issuer).toBe(srv.issuer);
      expect(srv.state.tokenAuth).toHaveLength(1);
    });
  });
});
