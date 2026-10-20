// The daemon in this process (no spawned child): protocol behavior, framing, validation, cursors,
// lifecycle timers and the session rules, driven over a real unix socket.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathContext } from '../../src/config/paths';
import { DaemonClient, DaemonConnection, DaemonStale } from '../../src/daemon/client';
import { daemonPaths, type DaemonPaths } from '../../src/daemon/paths';
import { DaemonServer, type DaemonOptions } from '../../src/daemon/server';
import { ExpiringResolver } from '../../src/daemon/sessions';
import { effectiveServer, envStamp, sessionKey } from '../../src/daemon/target';
import { encode, LineDecoder, MAX_LINE_BYTES } from '../../src/daemon/wire';
import type { ListResult, ServerTarget, ToolCallResult } from '../../src/protocol';
import type { CursorRecord } from '../../src/render/cursor';
import { TOOLS } from '../fixtures/mcp/mock-server.mjs';
import { FakeResolver, httpServer, stdioServer } from '../helpers/client';
import { alive, waitFor } from '../helpers/daemon';

const VERSION = '9.9.9-test';

interface Harness {
  daemon: DaemonServer;
  paths: DaemonPaths;
  home: string;
  connect(): Promise<DaemonConnection>;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function startDaemon(options: Partial<DaemonOptions> = {}, env: Record<string, string> = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'via-dp-'));
  const home = join(root, 'home');
  const ctx = pathContext({ home, env: { XDG_RUNTIME_DIR: root }, platform: 'linux' });
  const paths = daemonPaths(ctx);
  const daemon = new DaemonServer({ paths, version: VERSION, idleTimeoutMs: 60_000, env: { PATH: process.env.PATH ?? '', ...env }, home, platform: 'linux', ...options });
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
    const socket = createConnection(h.paths.socket);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(encode({ id: '1', type: 'status' }));
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
  });

  it('refuses a wrong token and keeps serving others', async () => {
    const h = await startDaemon();
    const socket = createConnection(h.paths.socket);
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
    const successor = new DaemonServer({ paths: h.paths, version: 'another-version', idleTimeoutMs: 60_000, env: {}, home: h.home, platform: 'linux' });
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
    expect(response).toMatchObject({ ok: false, error: { exitCode: 5, next: 'via trust /p/.via.yaml' } });
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
    const first = (await conn.request({ type: 'list', ...t, timeoutMs: 5000 })) as { result: ListResult };
    expect(first.result).toMatchObject({ fromCache: false });
    expect(first.result.tools.map((x) => x.name)).toEqual(TOOLS.map((x) => x.name));
    const second = (await conn.request({ type: 'list', ...t, timeoutMs: 5000 })) as { result: ListResult };
    expect(second.result).toMatchObject({ fromCache: true, fetchedAt: first.result.fetchedAt });
    const forced = (await conn.request({ type: 'list', ...t, timeoutMs: 5000, refresh: true })) as { result: ListResult };
    expect(forced.result.fromCache).toBe(false);
  });

  it('writes the disk cache the in-process mode reads', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const server = stdioServer();
    await conn.request({ type: 'list', ...target(server), timeoutMs: 5000 });
    const { CatalogCache } = await import('../../src/cli/catalog-cache');
    const hit = new CatalogCache(join(h.home, '.cache', 'via', 'catalog')).read(server);
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
      const r = (await conn.request({ type: 'list', ...t, timeoutMs: 5000 })) as { result: ListResult };
      return r.result.tools.some((x) => x.name === 'extra_1');
    }, 3000, 'the refreshed catalog');
    const again = (await conn.request({ type: 'list', ...t, timeoutMs: 5000 })) as { result: ListResult };
    expect(again.result.fromCache).toBe(true);
    const { CatalogCache } = await import('../../src/cli/catalog-cache');
    expect(new CatalogCache(join(h.home, '.cache', 'via', 'catalog')).read(server)?.tools.some((x) => x.name === 'extra_1')).toBe(true);
  });

  it('coalesces a burst of list_changed notifications', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const t = target(stdioServer());
    await conn.request({ type: 'list', ...t, timeoutMs: 5000 });
    for (let i = 0; i < 3; i += 1) await conn.request({ type: 'call', ...t, rawName: 'add_tool', args: {} });
    await waitFor(async () => {
      const r = (await conn.request({ type: 'list', ...t, timeoutMs: 5000 })) as { result: ListResult };
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
    const effective = effectiveServer(server, '/work/project');
    expect(effective.transport).toMatchObject({ cwd: '/work/project', env: { SECRET_FILE: 'file:/work/project/keys/token', ABS: 'file:/etc/x', HOME_FILE: 'file:~/t', KEY: 'env:K' } });
    expect(effectiveServer(stdioServer({ transport: { type: 'stdio', command: 'x', args: [], env: {}, cwd: 'sub' } }), '/work').transport).toMatchObject({ cwd: '/work/sub' });
    expect(sessionKey(effective)).not.toBe(sessionKey(effectiveServer(server, '/elsewhere')));
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

describe('lifecycle timers', () => {
  it('exits after the idle timeout and removes its files', async () => {
    const h = await startDaemon({ idleTimeoutMs: 150 });
    await h.daemon.closed;
    expect(() => readFileSync(h.paths.socket)).toThrow();
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

  it('exits when its socket file is removed', async () => {
    const h = await startDaemon({ watchMs: 50 });
    rmSync(h.paths.socket);
    await h.daemon.closed;
  });

  it('start() reports a running daemon instead of taking over its socket', async () => {
    const h = await startDaemon();
    const second = new DaemonServer({ paths: h.paths, version: VERSION, idleTimeoutMs: 60_000, env: {}, home: h.home, platform: 'linux' });
    expect(await second.start()).toBe('running');
    await h.connect(); // the first one still answers
  });

  it('shutdown answers, stops listening at once and exits when the requests are done', async () => {
    const h = await startDaemon();
    const conn = await h.connect();
    const slow = conn.request({ type: 'call', ...target(stdioServer()), rawName: 'slow', args: { ms: 300 } });
    await new Promise((r) => setTimeout(r, 100));
    const other = await h.connect();
    expect((await other.request({ type: 'shutdown' })).ok).toBe(true);
    expect(await DaemonConnection.connect(h.paths, VERSION)).toEqual({ refused: 'absent' });
    expect((await slow).ok).toBe(true);
    await h.daemon.closed;
  });
});

describe('client', () => {
  it('does not start a daemon when asked not to', async () => {
    const root = mkdtempSync(join(tmpdir(), 'via-dc-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const client = new DaemonClient({
      paths: daemonPaths(pathContext({ home: root, env: { XDG_RUNTIME_DIR: root }, platform: 'linux' })),
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
    const list = (await conn.request({ type: 'list', ...t, timeoutMs: 5000 })) as { result: ListResult };
    expect(list.result.tools).toHaveLength(TOOLS.length);
    const echo = (await conn.request({ type: 'call', ...t, rawName: 'echo', args: { message: 'x' } })) as { result: ToolCallResult };
    expect(echo.result.content?.[0]).toMatchObject({ text: 'echo: x' });
  });
});
