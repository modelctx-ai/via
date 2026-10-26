// The daemon in this process (no spawned child): protocol behavior, framing, validation, cursors,
// lifecycle timers and the session rules, driven over a real unix socket (on Windows a named pipe).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathContext, userCacheDir } from '../../src/config/paths';
import { DaemonClient, DaemonConnection, DaemonStale } from '../../src/daemon/client';
import { daemonPaths, endpointOf, type DaemonPaths } from '../../src/daemon/paths';
import { DaemonServer, type DaemonOptions } from '../../src/daemon/server';
import { ExpiringResolver } from '../../src/daemon/sessions';
import { effectiveServer, envStamp, sessionKey } from '../../src/daemon/target';
import { encode, LineDecoder, MAX_LINE_BYTES } from '../../src/daemon/wire';
import type { ListedTools, ServerTarget, ToolCallResult } from '../../src/protocol';
import type { CursorRecord } from '../../src/render/cursor';
import { TOOLS } from '../fixtures/mcp/mock-server.mjs';
import { FakeResolver, httpServer, stdioServer } from '../helpers/client';
import { alive, waitFor } from '../helpers/daemon';

const VERSION = '9.9.9-test';

const isWindows = process.platform === 'win32';

/**
 * Where a daemon of this test lives: a private runtime directory on POSIX; on Windows the cache
 * directory below `LOCALAPPDATA` and a pipe whose name carries a user name of its own, so parallel
 * test files never share a pipe.
 */
function sandboxPaths(root: string, home: string): DaemonPaths {
  if (!isWindows) return daemonPaths(pathContext({ home, env: { XDG_RUNTIME_DIR: root }, platform: 'linux' }));
  const user = `via-test-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  return daemonPaths(pathContext({ home, env: { LOCALAPPDATA: join(root, 'local'), USERNAME: user }, platform: 'win32' }));
}

interface Harness {
  daemon: DaemonServer;
  paths: DaemonPaths;
  home: string;
  /** What the daemon listens on (the socket path; for a derived pipe, its full name). */
  endpoint: string;
  /** The catalog cache directory the daemon writes (`<user cache dir>/catalog`). */
  catalogDir: string;
  /** The environment the daemon was given (it decides the user cache directory). */
  daemonEnv: Record<string, string>;
  connect(): Promise<DaemonConnection>;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function startDaemon(options: Partial<DaemonOptions> = {}, env: Record<string, string> = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'via-dp-'));
  const home = join(root, 'home');
  const paths = sandboxPaths(root, home);
  const platform = isWindows ? 'win32' : 'linux';
  const daemonEnv = { PATH: process.env.PATH ?? '', ...(isWindows ? { LOCALAPPDATA: join(root, 'local') } : {}), ...env };
  const daemon = new DaemonServer({ paths, version: VERSION, idleTimeoutMs: 60_000, env: daemonEnv, home, platform, ...options });
  expect(await daemon.start()).toBe('started');
  const conns: DaemonConnection[] = [];
  cleanups.push(async () => {
    for (const c of conns) c.close();
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    daemon,
    paths,
    home,
    endpoint: daemon.address,
    catalogDir: join(userCacheDir(pathContext({ home, env: daemonEnv, platform })), 'catalog'),
    daemonEnv,
    connect: async () => {
      const result = await DaemonConnection.connect(paths, VERSION);
      if (!('conn' in result)) throw new Error(`refused: ${result.refused}`);
      conns.push(result.conn);
      return result.conn;
    },
  };
}

const target = (server = stdioServer(), env: Record<string, string> = {}): ServerTarget => ({
  server,
  cwd: tmpdir(),
  idleTimeout: 60,
  envStamp: envStamp(server, env),
});

describe('wire format', () => {
  it('splits a stream into lines whatever the chunking', () => {
    const decoder = new LineDecoder();
    expect(decoder.push(Buffer.from('{"a":1}\n{"b"'))).toEqual(['{"a":1}']);
    expect(decoder.push(Buffer.from(':2}\n\n{"c":3}\n'))).toEqual(['{"b":2}', '{"c":3}']);
  });

  it('does not cut a multi-byte character that spans two chunks', () => {
    const bytes = Buffer.from(`${JSON.stringify({ text: '支持 OAuth 😀' })}\n`);
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const decoder = new LineDecoder();
      const lines = [...decoder.push(bytes.subarray(0, cut)), ...decoder.push(bytes.subarray(cut))];
      expect(lines).toEqual([JSON.stringify({ text: '支持 OAuth 😀' })]);
    }
  });

  it('refuses a line that never ends', () => {
    const decoder = new LineDecoder();
    const chunk = Buffer.alloc(32 * 1024 * 1024, 97);
    expect(() => {
      for (let i = 0; i <= MAX_LINE_BYTES / chunk.length; i += 1) decoder.push(chunk);
    }).toThrow('message too large');
  });

  it('encodes one JSON value per line, escaping newlines', () => {
    expect(encode({ text: 'a\nb' })).toBe('{"text":"a\\nb"}\n');
  });
});

describe('handshake', () => {
  it('answers hello with the daemon version and pid', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    expect(conn.version).toBe(VERSION);
    expect(conn.pid).toBe(process.pid);
  });

  it('drops a connection whose first message is not hello', async () => {
    const h = await startDaemon();
    const socket = createConnection(h.endpoint);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(encode({ id: '1', type: 'status' }));
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
  });

  it('refuses a wrong token and keeps serving others', async () => {
    const h = await startDaemon();
    const socket = createConnection(h.endpoint);
    const reply = await new Promise<string>((resolve) => {
      socket.once('connect', () => socket.write(encode({ type: 'hello', version: VERSION, pid: 1, token: 'wrong' })));
      socket.once('data', (d) => resolve(d.toString()));
    });
    expect(JSON.parse(reply)).toMatchObject({ type: 'hello', ok: false, reason: 'token' });
    await h.connect();
  });

  it('on a version mismatch refuses, frees the socket, finishes and exits', async () => {
    const h = await startDaemon();
    const result = await DaemonConnection.connect(h.paths, 'another-version');
    expect(result).toEqual({ refused: 'version', version: VERSION });
    await h.daemon.closed;
    // The socket path is free for the CLI's successor.
    const successor = new DaemonServer({ paths: h.paths, version: 'another-version', idleTimeoutMs: 60_000, env: {}, home: h.home, platform: isWindows ? 'win32' : 'linux' });
    expect(await successor.start()).toBe('started');
    cleanups.push(() => successor.stop());
  });

  it('lets in-flight requests finish before it exits for a version mismatch', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const slow = conn.request({ type: 'call', ...target(stdioServer()), rawName: 'slow', args: { ms: 400 } });
    await new Promise((r) => setTimeout(r, 150));
    expect(await DaemonConnection.connect(h.paths, 'another-version')).toMatchObject({ refused: 'version' });
    const response = await slow;
    expect(response.ok).toBe(true);
    await h.daemon.closed;
  });
});

describe('requests', () => {
  it('answers an unknown type with exit code 7 and keeps the connection', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const response = await conn.request({ type: 'frobnicate' } as never);
    expect(response).toMatchObject({ type: 'result', ok: false, error: { exitCode: 7 } });
    expect((await conn.request({ type: 'status' })).ok).toBe(true);
  });

  it('answers batch and auth with exit code 7: they are not served by the daemon yet', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    expect(await conn.request({ type: 'batch', calls: [] })).toMatchObject({ ok: false, error: { exitCode: 7 } });
    expect(await conn.request({ type: 'auth', action: 'status', provider: 'x' })).toMatchObject({ ok: false, error: { exitCode: 7 } });
  });

  it('matches replies to requests by id when they overlap', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const t = target(stdioServer());
    const [slow, fast] = await Promise.all([
      conn.request({ type: 'call', ...t, rawName: 'slow', args: { ms: 300 } }),
      conn.request({ type: 'call', ...t, rawName: 'echo', args: { message: 'quick' } }),
    ]);
    expect((slow as { result: ToolCallResult }).result.content?.[0]).toMatchObject({ text: 'done' });
    expect((fast as { result: ToolCallResult }).result.content?.[0]).toMatchObject({ text: 'echo: quick' });
  });

  it('streams progress as events and the result afterwards', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const { CLI_STDIO_SERVER } = await import('../cli/helpers');
    const server = stdioServer({ args: [CLI_STDIO_SERVER] });
    const events: unknown[] = [];
    const response = await conn.request({ type: 'call', ...target(server), rawName: 'run_job', args: {}, progress: true }, { onEvent: (e) => events.push(e.data) });
    expect(response.ok).toBe(true);
    expect(events).toEqual([{ progress: 1, total: 2, message: 'halfway' }]);
  });

  it('refuses an untrusted project server before starting anything', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const server = stdioServer({ trusted: false, untrustedPaths: ['/p/.via.yaml'] });
    const response = await conn.request({ type: 'call', ...target(server), rawName: 'pid', args: {} });
    expect(response).toMatchObject({ ok: false, error: { exitCode: 5, next: 'ask the user to run this in a terminal: via trust /p/.via.yaml' } });
    expect((await h.daemon['sessions'].status()).length).toBe(0);
  });

  it('tells a caller whose environment differs for a referenced variable to restart it', async () => {
    const h = await startDaemon({}, { MOCK_KEY: 'value-in-the-daemon-env' });
    const conn = await h.connect();
    const server = stdioServer({ env: { MOCK_SECRET: 'env:MOCK_KEY' } });
    const t = target(server, { MOCK_KEY: 'a-different-value' });
    await expect(conn.request({ type: 'call', ...t, rawName: 'pid', args: {} })).rejects.toBeInstanceOf(DaemonStale);
    const same = target(server, { MOCK_KEY: 'value-in-the-daemon-env' });
    expect((await conn.request({ type: 'call', ...same, rawName: 'pid', args: {} })).ok).toBe(true);
  });

  it('refuses a caller with other values without touching its own sessions, and never takes its values', async () => {
    const VALUE_A = 'value-from-shell-a-0001';
    const VALUE_B = 'value-from-shell-b-0002';
    const h = await startDaemon({}, { MOCK_KEY: VALUE_A });
    const conn = await h.connect();
    const server = stdioServer({ env: { MOCK_SECRET: 'env:MOCK_KEY' } });
    const pidOf = async (t: ServerTarget): Promise<string> => {
      const response = (await conn.request({ type: 'call', ...t, rawName: 'pid', args: {} })) as { result: ToolCallResult };
      return (response.result.content?.[0] as { text: string }).text;
    };
    const a = target(server, { MOCK_KEY: VALUE_A });
    const b = target(server, { MOCK_KEY: VALUE_B });
    const pid = await pidOf(a);
    for (let i = 0; i < 3; i += 1) {
      // Every kind of request is refused for B, without a session or a process being made for it.
      await expect(conn.request({ type: 'call', ...b, rawName: 'pid', args: {} })).rejects.toBeInstanceOf(DaemonStale);
      await expect(conn.request({ type: 'list', ...b, timeoutMs: 5000 })).rejects.toBeInstanceOf(DaemonStale);
      expect(await pidOf(a)).toBe(pid);
    }
    expect(h.daemon['sessions'].status()).toHaveLength(1);
    // A variable the caller has not set has its own digest too: refused, never answered with the daemon's value.
    await expect(conn.request({ type: 'call', ...target(server, {}), rawName: 'pid', args: {} })).rejects.toBeInstanceOf(DaemonStale);
  });

  it('maps a missing credential to exit code 4 before any process is started', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const t = target(stdioServer({ env: { MOCK_SECRET: 'env:NOT_SET_ANYWHERE' } }));
    const response = await conn.request({ type: 'list', ...t, timeoutMs: 5000 });
    expect(response).toMatchObject({ ok: false, error: { exitCode: 4 } });
    expect(h.daemon['sessions'].status().every((s: { pid?: number }) => s.pid === undefined)).toBe(true);
  });
});

describe('catalog', () => {
  it('serves the second list from memory and refresh from the server', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const t = target(stdioServer());
    const first = (await conn.request({ type: 'list', ...t, timeoutMs: 5000 })) as { result: ListedTools };
    expect(first.result).toMatchObject({ fromCache: false });
    expect(first.result.tools.map((x) => x.name)).toEqual(TOOLS.map((x) => x.name));
    const second = (await conn.request({ type: 'list', ...t, timeoutMs: 5000 })) as { result: ListedTools };
    expect(second.result).toMatchObject({ fromCache: true, fetchedAt: first.result.fetchedAt });
    const forced = (await conn.request({ type: 'list', ...t, timeoutMs: 5000, refresh: true })) as { result: ListedTools };
    expect(forced.result.fromCache).toBe(false);
  });

  describe('`have`: the caller already holds a build of this list', () => {
    const list = async (conn: DaemonConnection, t: ServerTarget, extra: { have?: number; refresh?: boolean } = {}) =>
      (await conn.request({ type: 'list', ...t, timeoutMs: 5000, ...extra })) as { ok: boolean; result: ListedTools | { unchanged: true; fetchedAt: number; fromCache: true }; error?: { exitCode: number } };

    it('leaves the tools out when the daemon\'s list is the one the caller has, and sends them otherwise', async () => {
      const h = await startDaemon();
      const conn = await h.connect();
      const t = target(stdioServer());
      const first = await list(conn, t);
      const at = first.result.fetchedAt;
      const same = await list(conn, t, { have: at });
      expect(same.result).toEqual({ unchanged: true, fetchedAt: at, fromCache: true, features: { resources: false, prompts: false, completions: false, skills: false }, protocol: { version: expect.stringMatching(/^\d{4}-\d\d-\d\d$/), stateful: expect.any(Boolean) } });
      const other = await list(conn, t, { have: at - 1 });
      expect(other.result).toMatchObject({ fetchedAt: at, fromCache: true });
      expect((other.result as ListedTools).tools.map((x) => x.name)).toEqual(TOOLS.map((x) => x.name));
    });

    it('answers from the disk cache the same way, for a daemon that has not listed the server itself', async () => {
      const h = await startDaemon();
      const server = stdioServer();
      const { CatalogCache } = await import('../../src/cli/catalog-cache');
      new CatalogCache(h.catalogDir).write(server, TOOLS as never, { fetchedAt: Date.now() });
      const conn = await h.connect();
      const t = target(server);
      const full = await list(conn, t);
      expect(full.result).toMatchObject({ fromCache: true });
      const again = await list(conn, t, { have: full.result.fetchedAt });
      expect(again.result).toMatchObject({ unchanged: true });
    });

    it('ignores `have` when asked to refresh: a refresh always brings the new list', async () => {
      const h = await startDaemon();
      const conn = await h.connect();
      const t = target(stdioServer());
      const first = await list(conn, t);
      const forced = await list(conn, t, { have: first.result.fetchedAt, refresh: true });
      expect(forced.result).toMatchObject({ fromCache: false });
      expect((forced.result as ListedTools).tools.length).toBe(TOOLS.length);
    });

    it('still resolves credentials first: a missing one is exit code 4 whatever the caller has', async () => {
      const h = await startDaemon();
      const conn = await h.connect();
      const t = target(stdioServer({ env: { MOCK_SECRET: 'env:NOT_SET_ANYWHERE' } }));
      const response = await list(conn, t, { have: 12345 });
      expect(response).toMatchObject({ ok: false, error: { exitCode: 4 } });
    });
  });

  describe('memory', () => {
    type Entries = Map<string, { tools?: unknown[]; toolCount?: number }>;
    const entriesOf = (h: Harness): Entries => (h.daemon as unknown as { sessions: { entries: Entries } }).sessions.entries;

    it('does not keep a parsed list when the cache file holds it, and still answers and counts', async () => {
      const h = await startDaemon();
      const conn = await h.connect();
      const t = target(stdioServer());
      const first = (await conn.request({ type: 'list', ...t, timeoutMs: 5000 })) as { result: ListedTools };
      const [entry] = [...entriesOf(h).values()];
      expect(entry!.tools).toBeUndefined();
      expect(entry!.toolCount).toBe(TOOLS.length);
      const again = (await conn.request({ type: 'list', ...t, timeoutMs: 5000 })) as { result: ListedTools };
      expect(again.result).toMatchObject({ fromCache: true, fetchedAt: first.result.fetchedAt });
      expect(again.result.tools.map((x) => x.name)).toEqual(TOOLS.map((x) => x.name));
      expect(h.daemon['sessions'].status()[0]).toMatchObject({ tools: TOOLS.length });
    });

    it('keeps it in memory when it cannot be written to disk', async () => {
      const h = await startDaemon();
      // A file where the catalog directory should be: unwritable on every platform (chmod does not
      // do it on Windows). The rest of the cache directory stays, the daemon's token file lives there.
      mkdirSync(dirname(h.catalogDir), { recursive: true });
      writeFileSync(h.catalogDir, 'a file where the catalog directory should be');
      const conn = await h.connect();
      const t = target(stdioServer());
      const first = (await conn.request({ type: 'list', ...t, timeoutMs: 5000 })) as { result: ListedTools };
      expect([...entriesOf(h).values()][0]!.tools).toHaveLength(TOOLS.length);
      const again = (await conn.request({ type: 'list', ...t, timeoutMs: 5000 })) as { result: ListedTools };
      expect(again.result).toMatchObject({ fromCache: true, fetchedAt: first.result.fetchedAt });
    });

    it('asks the server again if the cache file it relied on is gone', async () => {
      const h = await startDaemon();
      const conn = await h.connect();
      const t = target(stdioServer());
      await conn.request({ type: 'list', ...t, timeoutMs: 5000 });
      rmSync(h.catalogDir, { recursive: true, force: true });
      const again = (await conn.request({ type: 'list', ...t, timeoutMs: 5000 })) as { result: ListedTools };
      expect(again.result.fromCache).toBe(false);
      expect(again.result.tools).toHaveLength(TOOLS.length);
    });
  });

  it('writes the disk cache the in-process mode reads', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const server = stdioServer();
    await conn.request({ type: 'list', ...target(server), timeoutMs: 5000 });
    const { CatalogCache } = await import('../../src/cli/catalog-cache');
    const hit = new CatalogCache(h.catalogDir).read(server);
    expect(hit?.tools.map((x) => x.name)).toEqual(TOOLS.map((x) => x.name));
  });

  it('follows list_changed: memory copy and disk cache are replaced', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const server = stdioServer();
    const t = target(server);
    await conn.request({ type: 'list', ...t, timeoutMs: 5000 });
    await conn.request({ type: 'call', ...t, rawName: 'add_tool', args: {} });
    await waitFor(async () => {
      const r = (await conn.request({ type: 'list', ...t, timeoutMs: 5000 })) as { result: ListedTools };
      return r.result.tools.some((x) => x.name === 'extra_1');
    }, 3000, 'the refreshed catalog');
    const again = (await conn.request({ type: 'list', ...t, timeoutMs: 5000 })) as { result: ListedTools };
    expect(again.result.fromCache).toBe(true);
    const { CatalogCache } = await import('../../src/cli/catalog-cache');
    expect(new CatalogCache(h.catalogDir).read(server)?.tools.some((x) => x.name === 'extra_1')).toBe(true);
  });

  it('coalesces a burst of list_changed notifications', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const t = target(stdioServer());
    await conn.request({ type: 'list', ...t, timeoutMs: 5000 });
    for (let i = 0; i < 3; i += 1) await conn.request({ type: 'call', ...t, rawName: 'add_tool', args: {} });
    await waitFor(async () => {
      const r = (await conn.request({ type: 'list', ...t, timeoutMs: 5000 })) as { result: ListedTools };
      return r.result.tools.length === TOOLS.length + 3;
    }, 3000, 'all three tools');
  });
});

describe('sessions', () => {
  it('one server process serves every connection', async () => {
    const h = await startDaemon();
    const a = await h.connect();
    const b = await h.connect();
    const t = target(stdioServer());
    const pid = async (c: DaemonConnection) => ((await c.request({ type: 'call', ...t, rawName: 'pid', args: {} })) as { result: ToolCallResult }).result.content?.[0];
    expect(await pid(a)).toEqual(await pid(b));
  });

  it('applies the concurrency limit to calls from different connections', async () => {
    const h = await startDaemon();
    const conns = await Promise.all([1, 2, 3, 4].map(() => h.connect()));
    const t = target(stdioServer({ concurrency: 2 }));
    await Promise.all(conns.flatMap((c) => [c.request({ type: 'call', ...t, rawName: 'busy', args: {} }), c.request({ type: 'call', ...t, rawName: 'busy', args: {} })]));
    const max = (await conns[0]!.request({ type: 'call', ...t, rawName: 'max_busy', args: {} })) as { result: ToolCallResult };
    expect(max.result.content?.[0]).toMatchObject({ text: '2' });
  });

  it('starts a new session when the definition of a server changes, and closes the old one', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const pidOf = async (t: ServerTarget) => (((await conn.request({ type: 'call', ...t, rawName: 'pid', args: {} })) as { result: ToolCallResult }).result.content?.[0] as { text: string }).text;
    const first = await pidOf(target(stdioServer({ env: { A: '1' } })));
    const second = await pidOf(target(stdioServer({ env: { A: '2' } })));
    expect(second).not.toBe(first);
    await waitFor(() => !alive(Number(first)), 3000, 'the old process to exit');
  });

  it('applies the caller\'s working directory to a stdio server without one', () => {
    const server = stdioServer({ env: { SECRET_FILE: 'file:keys/token', ABS: 'file:/etc/x', HOME_FILE: 'file:~/t', KEY: 'env:K' } });
    const work = resolve('/work/project'); // a drive letter is prepended on Windows
    const effective = effectiveServer(server, work);
    expect(effective.transport).toMatchObject({ cwd: work, env: { SECRET_FILE: `file:${join(work, 'keys/token')}`, ABS: 'file:/etc/x', HOME_FILE: 'file:~/t', KEY: 'env:K' } });
    expect(effectiveServer(stdioServer({ transport: { type: 'stdio', command: 'x', args: [], env: {}, cwd: 'sub' } }), resolve('/work')).transport).toMatchObject({ cwd: resolve('/work', 'sub') });
    expect(sessionKey(effective)).not.toBe(sessionKey(effectiveServer(server, resolve('/elsewhere'))));
  });
});

describe('OAuth credential references across the socket', () => {
  it('the client secret and private key follow the caller: relative file: paths become absolute, env: variables go into the stamp', () => {
    const server = httpServer('http://x/mcp', { auth: { type: 'oauth', grant: 'client_credentials', clientId: 'c', clientSecret: 'env:CI_SECRET', privateKey: 'file:keys/ci.pem', keyAlgorithm: 'ES256' } });
    const work = resolve('/work/project');
    expect(effectiveServer(server, work).auth).toMatchObject({ clientSecret: 'env:CI_SECRET', privateKey: `file:${join(work, 'keys/ci.pem')}`, keyAlgorithm: 'ES256' });
    const a = envStamp(server, { CI_SECRET: 'secret-value-one' });
    expect(a).not.toBe('');
    expect(a).not.toContain('secret-value-one');
    expect(a).not.toBe(envStamp(server, { CI_SECRET: 'secret-value-two' }));
  });
});

describe('env stamp', () => {
  it('differs when a referenced variable differs and never contains the value', () => {
    const server = httpServer('http://x/mcp', { auth: { type: 'bearer', bearer: 'env:TOKEN' } });
    const a = envStamp(server, { TOKEN: 'secret-value-one' });
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(envStamp(server, { TOKEN: 'secret-value-two' }));
    expect(a).toBe(envStamp(server, { TOKEN: 'secret-value-one', OTHER: 'ignored' }));
    expect(envStamp(httpServer('http://x/mcp'), { TOKEN: 'secret-value-one' })).toBe('');
  });
});

describe('validate', () => {
  const schema = { type: 'object', properties: { n: { type: 'integer' }, when: { type: 'string', format: 'date' } }, required: ['n'] };

  it('compiles a schema once and reports errors as data', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const compiled = await conn.request({ type: 'validate', schema, label: 't', compileOnly: true });
    expect(compiled).toMatchObject({ ok: true, result: { ok: true, errors: [] } });
    const bad = (await conn.request({ type: 'validate', schema, label: 't', data: { n: 'x' } })) as { result: { errors: Array<{ keyword: string }> } };
    expect(bad.result.errors.map((e) => e.keyword)).toEqual(['type']);
    const formats = (await conn.request({ type: 'validate', schema, label: 't', data: { n: 1, when: 'tomorrow' } })) as { result: { errors: unknown[]; formats: Array<{ keyword: string }> } };
    expect(formats.result.errors).toEqual([]);
    expect(formats.result.formats.map((e) => e.keyword)).toEqual(['format']);
  });

  it('says so when a schema cannot be compiled', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const response = (await conn.request({ type: 'validate', schema: { type: 'nonsense' }, label: 't', compileOnly: true })) as { result: { ok: boolean } };
    expect(response.result.ok).toBe(false);
  });
});

describe('cursors', () => {
  const record: CursorRecord = { ref: 'gh issue:list', header: ['h'], lines: ['a', 'b'], offset: 1, shownBytes: 4, totalBytes: 8, budget: 8, hiddenColumns: 0, createdAt: Date.now() };

  it('stores a record and returns it by id, and knows nothing of other ids', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const put = (await conn.request({ type: 'cursor-put', record })) as { result: string };
    expect(put.result).toMatch(/^[0-9a-f]{4,16}$/);
    expect(await conn.request({ type: 'cursor-get', cursor: put.result })).toMatchObject({ result: { record } });
    expect(await conn.request({ type: 'cursor-get', cursor: 'ffff' })).toMatchObject({ result: { record: null } });
    expect(((await conn.request({ type: 'status' })) as { result: { cursors: number } }).result.cursors).toBe(1);
  });
});

describe('OAuth refresh with a login store that cannot be written', () => {
  it('forwards one warning to the request that triggered the refresh, and keeps serving', async () => {
    const { startOAuthServer } = await import('../fixtures/mcp/oauth-server.mjs');
    const { createMemoryOAuthStore, performLogin } = await import('../../src/client/oauth');
    const srv = await startOAuthServer();
    cleanups.push(() => srv.close());
    const inner = createMemoryOAuthStore();
    await performLogin({
      target: { provider: 'linear', url: srv.url },
      store: inner,
      manual: false,
      timeoutMs: 10_000,
      io: {
        showUrl: () => undefined,
        note: () => undefined,
        openUrl: async (url) => {
          srv.browse(url).catch(() => undefined);
          return { opened: true };
        },
        readLine: async () => undefined,
      },
    });
    const readOnly = { get: inner.get.bind(inner), delete: inner.delete.bind(inner), set: async () => { throw new Error('EROFS: read-only file system'); } };
    const h = await startDaemon({ oauthStore: readOnly });
    const conn = await h.connect();
    const server = httpServer(srv.url, { name: 'linear', provider: 'linear', auth: { type: 'oauth' } });
    const call = async (message: string) => {
      const events: unknown[] = [];
      const response = (await conn.request({ type: 'call', ...target(server), rawName: 'echo_text', args: { message } }, { onEvent: (e) => events.push([e.event, e.data]) })) as { ok: boolean; result: ToolCallResult };
      return { response, events };
    };
    const first = await call('one');
    expect(first.response.ok).toBe(true);
    expect(first.events).toEqual([]);
    srv.expireAccessTokens(); // the server refuses the token: refresh, which cannot be saved
    const second = await call('two');
    expect(second.response.ok).toBe(true);
    expect(second.response.result.content?.[0]).toMatchObject({ text: 'echo: two' });
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject(['log', { level: 'warning', message: expect.stringContaining('could not save the refreshed OAuth login for linear') }]);
    // Once per session: a later refresh stays quiet, and the rotated token is still used (not the stale stored one).
    srv.expireAccessTokens();
    const third = await call('three');
    expect(third.response.ok).toBe(true);
    expect(third.events).toEqual([]);
    const secrets = [...srv.issuedAccessTokens(), ...srv.issuedRefreshTokens()];
    expect(JSON.stringify(second.events)).not.toMatch(new RegExp(secrets.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')));
  });
});

describe('cursors across daemon exit', () => {
  const record: CursorRecord = { ref: 'gh issue:list', header: ['h'], lines: ['a', 'b'], offset: 1, shownBytes: 4, totalBytes: 8, budget: 8, hiddenColumns: 0, createdAt: Date.now() };

  it('keeps a cursor readable after the daemon that stored it has exited (same TTL, private files)', async () => {
    const first = await startDaemon();
    const conn = await first.connect();
    const put = (await conn.request({ type: 'cursor-put', record })) as { result: string };
    conn.close();
    await first.daemon.stop();
    // A fresh daemon of the same user (same cache directory) still knows the cursor.
    const root = mkdtempSync(join(tmpdir(), 'via-dp2-'));
    const paths = sandboxPaths(root, first.home);
    const second = new DaemonServer({ paths, version: VERSION, idleTimeoutMs: 60_000, env: first.daemonEnv, home: first.home, platform: isWindows ? 'win32' : 'linux' });
    expect(await second.start()).toBe('started');
    cleanups.push(async () => {
      await second.stop();
      rmSync(root, { recursive: true, force: true });
    });
    const result = await DaemonConnection.connect(paths, VERSION);
    if (!('conn' in result)) throw new Error(`refused: ${result.refused}`);
    const got = (await result.conn.request({ type: 'cursor-get', cursor: put.result })) as { result: { record: CursorRecord | null } };
    result.conn.close();
    expect(got.result.record).toMatchObject({ ref: record.ref, lines: record.lines });
  });

  it('writes cursor files into the private user cache directory', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const put = (await conn.request({ type: 'cursor-put', record })) as { result: string };
    const dir = join(dirname(h.catalogDir), 'cursors');
    expect(statSync(join(dir, `${put.result}.json`)).isFile()).toBe(true);
    if (!isWindows) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, `${put.result}.json`)).mode & 0o777).toBe(0o600);
    }
  });
});

describe('lifecycle timers', () => {
  it('exits after the idle timeout and removes its files', async () => {
    const h = await startDaemon({ idleTimeoutMs: 150 });
    await h.daemon.closed;
    expect(() => readFileSync(h.endpoint)).toThrow(); // a socket file, or a pipe that is gone
    expect(() => readFileSync(h.paths.token)).toThrow();
  });

  it('is not idle while a connection is open or a request is running', async () => {
    const h = await startDaemon({ idleTimeoutMs: 200 });
    const conn = await h.connect();
    await new Promise((r) => setTimeout(r, 500));
    expect((await conn.request({ type: 'status' })).ok).toBe(true);
    conn.close();
    await h.daemon.closed;
  });

  // POSIX: the socket file is how clients find it. Windows: the token file is (it names the pipe and authenticates).
  it('exits when the file that makes it reachable is removed', async () => {
    const h = await startDaemon({ watchMs: 50 });
    rmSync(isWindows ? h.paths.token : h.endpoint);
    await h.daemon.closed;
  });

  it('start() reports a running daemon instead of taking over its socket', async () => {
    const h = await startDaemon();
    const second = new DaemonServer({ paths: h.paths, version: VERSION, idleTimeoutMs: 60_000, env: {}, home: h.home, platform: isWindows ? 'win32' : 'linux' });
    expect(await second.start()).toBe('running');
    await h.connect(); // the first one still answers
  });

  it('shutdown answers, stops listening at once and exits when the requests are done', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    // Start the stdio server first: the first connection probes the protocol in a copy of the server
    // before starting it for real, and two process starts on a Windows runner can outlast the
    // fixed wait below. Only shutdown is under test here, not connecting.
    expect((await conn.request({ type: 'call', ...target(stdioServer()), rawName: 'echo', args: { message: 'warm' } })).ok).toBe(true);
    const slow = conn.request({ type: 'call', ...target(stdioServer()), rawName: 'slow', args: { ms: 300 } });
    await new Promise((r) => setTimeout(r, 100));
    const other = await h.connect();
    expect((await other.request({ type: 'shutdown' })).ok).toBe(true);
    expect(await DaemonConnection.connect(h.paths, VERSION)).toEqual({ refused: 'absent' });
    expect((await slow).ok).toBe(true);
    await h.daemon.closed;
  });

  it('shutdown with force answers, then abandons the requests in flight and exits at once', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const slow = conn.request({ type: 'call', ...target(stdioServer()), rawName: 'slow', args: { ms: 10_000 } });
    const abandoned = expect(slow).rejects.toMatchObject({ name: 'DaemonUnavailable', sent: true });
    await new Promise((r) => setTimeout(r, 300));
    const other = await h.connect();
    const started = Date.now();
    expect(await other.request({ type: 'shutdown', force: true })).toMatchObject({ ok: true, result: { pid: process.pid } });
    await h.daemon.closed;
    expect(Date.now() - started).toBeLessThan(3000);
    await abandoned;
  });

  it('keeps a record of itself while it lives when asked to (via daemon run), naming its state', async () => {
    const h = await startDaemon({ record: true });
    const file = join(h.paths.records, `${process.pid}.json`);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pid: process.pid, state: 'running' });
    if (!isWindows) expect(statSync(file).mode & 0o777).toBe(0o600);
    const conn = await h.connect();
    const slow = conn.request({ type: 'call', ...target(stdioServer()), rawName: 'slow', args: { ms: 400 } });
    await new Promise((r) => setTimeout(r, 150));
    h.daemon.drain();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pid: process.pid, state: 'stopping' });
    await slow;
    await h.daemon.closed;
    expect(existsSync(file)).toBe(false);
  });

  it('removes its record when it finds another daemon already running', async () => {
    const h = await startDaemon();
    const second = new DaemonServer({ paths: h.paths, version: VERSION, idleTimeoutMs: 60_000, env: {}, home: h.home, platform: isWindows ? 'win32' : 'linux', record: true });
    expect(await second.start()).toBe('running');
    expect(existsSync(join(h.paths.records, `${process.pid}.json`))).toBe(false);
  });
});

// The default Windows pipe is named after the start token. The flow is the same over a unix socket,
// so it is tested here on every host with a hand-made `derived` path set.
describe('derived endpoint', () => {
  function derivedPaths(): { root: string; paths: DaemonPaths } {
    const root = mkdtempSync(join(tmpdir(), 'via-dd-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    return { root, paths: { dir: root, socket: join(root, 'v.sock'), lock: join(root, 'via.lock'), token: join(root, 'via.token'), log: join(root, 'via.log'), records: join(root, 'via.pids'), pipe: isWindows, derived: true } };
  }
  // On Windows a derived path set needs a pipe prefix; the pipe flag is the real thing there.
  const prefixed = (paths: DaemonPaths): DaemonPaths => (isWindows ? { ...paths, socket: `\\\\.\\pipe\\via-test-${process.pid}-${Math.random().toString(16).slice(2, 8)}` } : paths);
  const options = (paths: DaemonPaths, root: string) => ({ paths, version: VERSION, idleTimeoutMs: 60_000, env: {}, home: root, platform: isWindows ? ('win32' as const) : ('linux' as const) });

  it('listens on a name made from the token, which only the token file reveals', async () => {
    const { root, paths: base } = derivedPaths();
    const paths = prefixed(base);
    const daemon = new DaemonServer(options(paths, root));
    expect(await daemon.start()).toBe('started');
    cleanups.push(() => daemon.stop());
    const token = readFileSync(paths.token, 'utf8');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(daemon.address).toBe(endpointOf(paths, token));
    expect(daemon.address).toMatch(/-[0-9a-f]{32}$/);
    expect(daemon.address).not.toBe(paths.socket);
    if (!isWindows) expect(existsSync(paths.socket)).toBe(false); // the prefix itself is never bound

    const result = await DaemonConnection.connect(paths, VERSION);
    expect('conn' in result).toBe(true);
    if ('conn' in result) {
      expect(result.conn.pid).toBe(process.pid);
      result.conn.close();
    }
  });

  it('finds no daemon without a token file, and none at the name of a dead one', async () => {
    const { paths: base } = derivedPaths();
    const paths = prefixed(base);
    expect(await DaemonConnection.connect(paths, VERSION)).toEqual({ refused: 'absent' });
    writeFileSync(paths.token, 'f'.repeat(64)); // left behind by a daemon that was killed
    expect(await DaemonConnection.connect(paths, VERSION)).toEqual({ refused: 'absent' });
  });

  it('replaces a stale token file, names the new endpoint after the new token, and cleans up', async () => {
    const { root, paths: base } = derivedPaths();
    const paths = prefixed(base);
    writeFileSync(paths.token, 'e'.repeat(64));
    const daemon = new DaemonServer(options(paths, root));
    expect(await daemon.start()).toBe('started');
    const token = readFileSync(paths.token, 'utf8');
    expect(token).not.toBe('e'.repeat(64));
    expect(daemon.address).toBe(endpointOf(paths, token));
    await daemon.stop();
    expect(existsSync(paths.token)).toBe(false);
    expect(await DaemonConnection.connect(paths, VERSION)).toEqual({ refused: 'absent' });
  });

  it('a second daemon finds the first through the token file and leaves it alone', async () => {
    const { root, paths: base } = derivedPaths();
    const paths = prefixed(base);
    const first = new DaemonServer(options(paths, root));
    expect(await first.start()).toBe('started');
    cleanups.push(() => first.stop());
    const token = readFileSync(paths.token, 'utf8');
    const second = new DaemonServer(options(paths, root));
    expect(await second.start()).toBe('running');
    expect(readFileSync(paths.token, 'utf8')).toBe(token);
    expect('conn' in (await DaemonConnection.connect(paths, VERSION))).toBe(true);
  });

  it('a start that is racing another one (the lock is held) waits and then sees it', async () => {
    const { root, paths: base } = derivedPaths();
    const paths = prefixed(base);
    const racers = [1, 2, 3, 4].map(() => new DaemonServer(options(paths, root)));
    const outcomes = await Promise.all(racers.map((d) => d.start()));
    cleanups.push(() => Promise.all(racers.map((d) => d.stop())).then(() => undefined));
    expect(outcomes.filter((o) => o === 'started')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'running')).toHaveLength(3);
  });

  it('a wrong token is refused on a derived endpoint too', async () => {
    const { root, paths: base } = derivedPaths();
    const paths = prefixed(base);
    const daemon = new DaemonServer(options(paths, root));
    await daemon.start();
    cleanups.push(() => daemon.stop());
    const socket = createConnection(daemon.address);
    const reply = await new Promise<string>((resolveReply) => {
      socket.once('connect', () => socket.write(encode({ type: 'hello', version: VERSION, pid: 1, token: 'wrong' })));
      socket.once('data', (d) => resolveReply(d.toString()));
    });
    expect(JSON.parse(reply)).toMatchObject({ type: 'hello', ok: false, reason: 'token' });
  });
});

describe('client', () => {
  it('does not start a daemon when asked not to', async () => {
    const root = mkdtempSync(join(tmpdir(), 'via-dc-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const client = new DaemonClient({
      paths: sandboxPaths(root, root),
      version: VERSION,
      command: { command: process.execPath, args: ['-e', 'process.exit(1)'] },
      env: {},
      home: root,
      idleTimeoutSec: 1,
    });
    expect(await client.connection({ spawn: false })).toBeUndefined();
  });

  it('fails a pending request when the daemon goes away', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const pending = conn.request({ type: 'call', ...target(stdioServer()), rawName: 'slow', args: { ms: 2000 } });
    const settled = expect(pending).rejects.toMatchObject({ name: 'DaemonUnavailable', sent: true });
    await new Promise((r) => setTimeout(r, 100));
    await h.daemon.stop();
    await settled;
  });

  // One slow request must not condemn a connection that other requests (other servers) share.
  it('fails only the request past its deadline when the daemon still answers, and keeps the connection', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const slow = conn.request({ type: 'call', ...target(stdioServer()), rawName: 'slow', args: { ms: 3000 } }, { deadlineMs: 300 });
    await expect(slow).rejects.toMatchObject({ name: 'DaemonUnavailable', message: 'the via daemon did not answer in time', sent: true, requestOnly: true });
    expect(conn.closed).toBe(false);
    expect((await conn.request({ type: 'status' }, { deadlineMs: 2000 })).ok).toBe(true);
  });

  it('gives the connection up when the daemon does not answer status either', async () => {
    const root = mkdtempSync(join(tmpdir(), 'via-dc-'));
    const paths = sandboxPaths(root, join(root, 'home'));
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.token, 'mute', { mode: 0o600 });
    // Says hello, then never answers anything.
    const { createServer } = await import('node:net');
    const mute = createServer((socket) => {
      socket.once('data', () => socket.write(encode({ type: 'hello', version: VERSION, ok: true, pid: 1 })));
    });
    await new Promise<void>((r) => mute.listen(endpointOf(paths, 'mute')!, () => r()));
    cleanups.push(async () => {
      await new Promise<void>((r) => mute.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    });
    const result = await DaemonConnection.connect(paths, VERSION);
    if (!('conn' in result)) throw new Error('no connection');
    const conn = result.conn;
    const other = conn.request({ type: 'status' });
    const started = Date.now();
    await expect(conn.request({ type: 'status' }, { deadlineMs: 100 })).rejects.toMatchObject({ name: 'DaemonUnavailable', sent: true, requestOnly: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000); // the probe's own wait
    await expect(other).rejects.toMatchObject({ name: 'DaemonUnavailable' });
    expect(conn.closed).toBe(true);
  });
});

describe('ExpiringResolver', () => {
  it('forgets cached values after the ttl but keeps redacting what it returned', async () => {
    let clock = 0;
    let env = { KEY: 'first-secret-value' } as Record<string, string>;
    const make = () => new FakeResolver(env);
    const resolver = new ExpiringResolver(make, 1000, () => clock);
    const origin = { scope: 'user' } as const;
    expect(await resolver.resolve('env:KEY', origin)).toBe('first-secret-value');
    env = { KEY: 'second-secret-value' };
    clock = 500;
    expect(await resolver.resolve('env:KEY', origin)).toBe('first-secret-value');
    clock = 2000;
    expect(await resolver.resolve('env:KEY', origin)).toBe('second-secret-value');
    expect([...resolver.resolvedValues()].sort()).toEqual(['first-secret-value', 'second-secret-value']);
  });
});

describe('http servers', () => {
  it('list and call work for an HTTP server through the daemon', async () => {
    const { startHttpServer } = await import('../helpers/client');
    const srv = await startHttpServer();
    cleanups.push(() => srv.close());
    const h = await startDaemon();
    const conn = await h.connect();
    const t = target(httpServer(srv.url));
    const list = (await conn.request({ type: 'list', ...t, timeoutMs: 5000 })) as { result: ListedTools };
    expect(list.result.tools).toHaveLength(TOOLS.length);
    const echo = (await conn.request({ type: 'call', ...t, rawName: 'echo', args: { message: 'x' } })) as { result: ToolCallResult };
    expect(echo.result.content?.[0]).toMatchObject({ text: 'echo: x' });
  });
});
