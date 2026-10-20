// End to end with a real daemon: the CLI is bundled, `run()` is driven in this process, and the
// daemon it starts is a detached child process (the same path production takes).
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startOAuthServer } from '../fixtures/mcp/oauth-server.mjs';
import { VERSION } from '../../src/cli/help';
import { pathContext } from '../../src/config/paths';
import { DaemonServer } from '../../src/daemon/server';
import { daemonPaths } from '../../src/daemon/paths';
import { TOOLS } from '../fixtures/mcp/mock-server.mjs';
import { FAKE_TOKEN, ghConfig, startFixtureServer, useCleanup } from '../cli/helpers';
import { alive, builtCli, daemonSandbox, mockServerYaml, pgrep, waitFor } from '../helpers/daemon';

const config = (extra = '', top = '') => `sources: false\n${top}servers:\n${mockServerYaml('mock', extra)}`;

describe('auto-spawn and reuse', () => {
  it('starts the daemon on first use and keeps the same server process across invocations', async () => {
    const d = await daemonSandbox(config());
    expect(await d.status()).toBeUndefined();

    const first = await d.via(['mock', 'pid']);
    expect(first.code).toBe(0);
    expect(first.stderr).not.toContain('warning');
    const second = await d.via(['mock', 'pid']);
    expect(second.stdout).toBe(first.stdout);

    const status = await d.status();
    expect(status).toBeDefined();
    expect(status!.sessions).toHaveLength(1);
    expect(status!.sessions[0]).toMatchObject({ server: 'mock', transport: 'stdio', connected: true, calls: 2 });
    expect(String(status!.sessions[0]!.pid)).toBe(first.stdout.trim());
    expect(alive(status!.pid)).toBe(true);

    const stopped = await d.via(['daemon', 'stop']);
    expect(stopped.stdout).toBe(`daemon: stopped (pid ${status!.pid})\n`);
    await waitFor(() => !alive(status!.pid), 3000, 'daemon exit');
    expect(alive(Number(first.stdout.trim()))).toBe(false);
    expect(await d.status()).toBeUndefined();
  });

  it('VIA_NO_DAEMON=1 connects in-process: a new server process per invocation and no daemon', async () => {
    const d = await daemonSandbox(config());
    const env = { VIA_NO_DAEMON: '1' };
    const a = await d.via(['mock', 'pid'], { env });
    const b = await d.via(['mock', 'pid'], { env });
    expect(a.code).toBe(0);
    expect(a.stdout).not.toBe(b.stdout);
    expect(existsSync(d.socket)).toBe(false);
    expect((await d.via(['daemon', 'status'], { env })).stdout).toBe('daemon: disabled (VIA_NO_DAEMON)\n');
  });

  it('shows a readable status', async () => {
    const d = await daemonSandbox(config());
    const none = await d.via(['daemon', 'status']);
    expect(none.stdout).toBe(`daemon: not running\nsocket: ${d.socket}\n`);
    await d.via(['mock', 'echo', '--message', 'hi']);
    const r = await d.via(['daemon', 'status']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^daemon: running · pid \\d+ · v${VERSION.replace(/\./g, '\\.')} · up \\d+s · [\\d.]+ MB · exits when idle in \\d+m\\d+s\\nsocket: ${d.socket}\\nsessions: 1\\n  mock +stdio +running \\(pid \\d+\\) +${TOOLS.length} tools +1 call +idle \\d+s\\n$`));
    expect(r.stdout).not.toContain(d.sb.home);
  });

  it('routes browse, find and sync through the daemon', async () => {
    const d = await daemonSandbox(config());
    const root = await d.via([]);
    expect(root.stdout).toContain('mock');
    const find = await d.via(['find', 'echo']);
    expect(find.stdout).toContain('echo');
    const sync = await d.via(['sync']);
    expect(sync.stdout).toBe(`mock  ${TOOLS.length} tools\n`);
    expect((await d.status())!.sessions).toHaveLength(1);
  });
});

describe('lifecycle', () => {
  it('exits when idle', async () => {
    const d = await daemonSandbox(config('', 'daemon:\n  idleTimeout: 1\n'));
    await d.via(['mock', 'pid']);
    const status = (await d.status())!;
    expect(status.idleTimeoutMs).toBe(1000);
    await waitFor(() => !alive(status.pid), 4000, 'idle exit');
    expect(existsSync(d.socket)).toBe(false);
    expect(existsSync(`${d.socket}.token`)).toBe(false);
    expect(alive(status.sessions[0]!.pid!)).toBe(false);
  });

  it('stops an idle stdio server after serverIdleTimeout and starts a new one on demand', async () => {
    const d = await daemonSandbox(config('', 'daemon:\n  serverIdleTimeout: 1\n'));
    const first = await d.via(['mock', 'pid']);
    await waitFor(async () => (await d.status())!.sessions[0]!.connected === false, 4000, 'the server to stop');
    await waitFor(() => !alive(Number(first.stdout.trim())), 3000, 'the idle server process to exit');
    const second = await d.via(['mock', 'pid']);
    expect(second.stdout).not.toBe(first.stdout);
  });

  it('replaces a stale socket left by a dead daemon', async () => {
    const d = await daemonSandbox(config());
    const dead = spawn(process.execPath, ['-e', 'process.umask(0o177); require("net").createServer().listen(process.argv[1], () => console.log("up"))', d.socket], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => dead.stdout.once('data', () => resolve()));
    dead.kill('SIGKILL');
    await waitFor(() => dead.exitCode !== null || dead.signalCode !== null, 2000, 'the process to die');
    expect(existsSync(d.socket)).toBe(true);

    const r = await d.via(['mock', 'echo', '--message', 'hi']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('echo: hi\n');
    expect(r.stderr).not.toContain('warning');
    expect(await d.status()).toBeDefined();
  });

  it('restarts a daemon of another version and serves the request', async () => {
    const d = await daemonSandbox(config());
    const ctx = pathContext({ home: d.sb.home, env: { XDG_RUNTIME_DIR: d.runtime }, platform: 'linux' });
    const old = new DaemonServer({ paths: daemonPaths(ctx), version: '0.0.0-old', idleTimeoutMs: 60_000, env: {}, home: d.sb.home, platform: 'linux' });
    expect(await old.start()).toBe('started');

    const r = await d.via(['mock', 'echo', '--message', 'hi']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('echo: hi\n');
    await Promise.race([old.closed, new Promise((_, reject) => setTimeout(() => reject(new Error('the old daemon did not exit')), 3000))]);
    const status = (await d.status())!;
    expect(status.version).toBe(VERSION);
    expect(status.pid).not.toBe(process.pid);
  });

  it('lets only one daemon survive when several CLIs start at once', async () => {
    const d = await daemonSandbox(config());
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => d.via(['mock', 'echo', '--message', String(n)])));
    expect(results.map((r) => r.stdout)).toEqual(['echo: 1\n', 'echo: 2\n', 'echo: 3\n', 'echo: 4\n', 'echo: 5\n']);
    expect(results.every((r) => r.code === 0 && !r.stderr.includes('warning'))).toBe(true);
    await waitFor(() => pgrep(`daemon run --socket ${d.socket}`).length === 1, 4000, 'the losing daemons to exit');
  });
});

describe('concurrency', () => {
  it('limits calls to one server across separate CLI processes', async () => {
    const d = await daemonSandbox(config('    concurrency: 2\n'));
    await d.via(['mock', 'pid']); // warm: one daemon, one server
    const calls = await Promise.all([1, 2, 3, 4, 5, 6].map(() => d.via(['mock', 'busy'])));
    expect(calls.every((c) => c.code === 0)).toBe(true);
    const max = await d.via(['mock', 'max_busy']);
    expect(max.stdout).toBe('2\n');
  });
});

describe('list_changed', () => {
  it('refreshes the catalog and the disk cache when the server announces new tools', async () => {
    const d = await daemonSandbox(config());
    const before = await d.via(['mock']);
    expect(before.stdout).not.toContain('extra');
    await d.via(['mock', 'add_tool']);
    await waitFor(async () => (await d.via(['mock'])).stdout.includes('extra'), 4000, 'the new tool to show up');
    const status = (await d.status())!;
    expect(status.sessions[0]!.tools).toBe(TOOLS.length + 1);
    const cached = readdirSync(join(d.sb.cacheDir, 'catalog')).map((f) => readFileSync(join(d.sb.cacheDir, 'catalog', f), 'utf8'));
    expect(cached.some((text) => text.includes('extra_1'))).toBe(true);
  });
});

describe('falling back to in-process mode', () => {
  it('runs the call itself and says so once when the daemon cannot be started', async () => {
    const d = await daemonSandbox(config());
    const r = await d.via(['mock', 'echo', '--message', 'hi'], { daemonCommand: { command: '/nonexistent/via-node', args: [] } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('echo: hi\n');
    expect(r.stderr).toMatch(/^warning: cannot start the via daemon: ENOENT; continuing without the daemon \(VIA_NO_DAEMON=1 silences this\)\n· mock echo/);
    expect(r.stderr.match(/warning:/g)).toHaveLength(1);
  });

  it('reports why when the daemon process exits at once', async () => {
    const d = await daemonSandbox(config());
    const r = await d.via(['mock', 'pid'], { daemonCommand: { command: process.execPath, args: ['-e', 'process.exit(3)'] } });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('warning: cannot start the via daemon: it exited with code 3; continuing without the daemon');
  });

  it('does not repeat a call that may already have run when the connection breaks', async () => {
    const d = await daemonSandbox(config());
    await d.via(['mock', 'pid']);
    const pid = (await d.status())!.pid;
    // `slow` is not marked read-only: if the daemon dies mid-call the CLI must not run it again.
    const running = d.via(['mock', 'slow', '--ms', '3000']);
    await new Promise((r) => setTimeout(r, 400));
    process.kill(pid, 'SIGKILL');
    const r = await running;
    expect(r.code).toBe(6);
    expect(r.stderr).toContain('lost the connection to the via daemon while calling slow; it may or may not have run');
    expect(r.stderr).toContain('next: via daemon status');
  });
});

describe('socket security', () => {
  it('creates the socket and the token file readable by the owner only', async () => {
    const d = await daemonSandbox(config());
    await d.via(['mock', 'pid']);
    expect(statSync(d.socket).mode & 0o777).toBe(0o600);
    expect(statSync(`${d.socket}.token`).mode & 0o777).toBe(0o600);
  });

  it('refuses a socket other users could reach and works in-process instead', async () => {
    const d = await daemonSandbox(config());
    await d.via(['mock', 'pid']);
    chmodSync(d.socket, 0o666);
    try {
      const r = await d.via(['mock', 'echo', '--message', 'hi']);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain(`warning: not using the via daemon: ${d.socket} is accessible to other users; continuing without the daemon`);
    } finally {
      chmodSync(d.socket, 0o600);
    }
  });

  it('rejects a connection that does not know the token', async () => {
    const d = await daemonSandbox(config());
    await d.via(['mock', 'pid']);
    writeFileSync(`${d.socket}.token`, 'not-the-token', { mode: 0o600 });
    const r = await d.via(['mock', 'echo', '--message', 'hi']);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('refused the handshake (token mismatch); continuing without the daemon');
  });
});

describe('credentials', () => {
  const KEY = 'fake-daemon-secret-0123456789';

  it('resolves references in the daemon and redacts them from results and status', async () => {
    const d = await daemonSandbox(config('    env: { MOCK_SECRET: "env:MOCK_KEY" }\n'), { MOCK_KEY: KEY });
    const r = await d.via(['mock', 'read_env', '--name', 'MOCK_SECRET']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('***\n');
    const raw = await d.via(['mock', 'read_env', '--name', 'MOCK_SECRET', '-o', 'raw']);
    expect(raw.stdout).toBe('***\n');
    const status = await d.via(['daemon', 'status', '-o', 'json']);
    for (const text of [r.stdout, r.stderr, raw.stdout, raw.stderr, status.stdout, status.stderr]) expect(text).not.toContain(KEY);
    expect(existsSync(`${d.socket}.log`) ? readFileSync(`${d.socket}.log`, 'utf8') : '').not.toContain(KEY);
  });

  it('keeps the value off the socket: nothing a client can ask for contains it', async () => {
    const d = await daemonSandbox(config('    env: { MOCK_SECRET: "env:MOCK_KEY" }\n'), { MOCK_KEY: KEY });
    await d.via(['mock', 'read_env', '--name', 'MOCK_SECRET']);
    const { DaemonClient } = await import('../../src/daemon/client');
    const client = new DaemonClient({
      paths: daemonPaths(pathContext({ home: d.sb.home, env: { XDG_RUNTIME_DIR: d.runtime }, platform: 'linux' })),
      version: VERSION,
      command: { command: process.execPath, args: [] },
      env: {},
      home: d.sb.home,
      idleTimeoutSec: 60,
    });
    const conn = (await client.connection({ spawn: false }))!;
    const traffic: string[] = [];
    traffic.push(JSON.stringify(await conn.request({ type: 'status' })));
    traffic.push(JSON.stringify(await conn.request({ type: 'redact', text: `token ${KEY}` })));
    const unknown = await conn.request({ type: 'nope' } as never);
    traffic.push(JSON.stringify(unknown));
    client.close();
    expect(traffic[1]).toContain('token ***');
    for (const line of traffic) expect(line).not.toContain(KEY);
    expect(unknown).toMatchObject({ ok: false, error: { exitCode: 7 } });
  });

  it('restarts the daemon when the caller\'s environment differs, so a rotated token is used', async () => {
    const srv = await startFixtureServer({ token: 'token-B-for-daemon-tests' });
    useCleanup(() => srv.close());
    const d = await daemonSandbox(ghConfig(srv.url), { GH_TOKEN: 'token-A-for-daemon-tests' });
    const wrong = await d.via(['gh', 'echo-text', '--message', 'hi']);
    expect(wrong.code).toBe(4);
    const first = (await d.status())!;
    const right = await d.via(['gh', 'echo-text', '--message', 'hi'], { env: { GH_TOKEN: 'token-B-for-daemon-tests' } });
    expect(right.code).toBe(0);
    expect(right.stdout).toBe('echo: hi\n');
    expect(right.stderr).not.toContain('warning');
    const second = (await d.via(['daemon', 'status', '-o', 'json'], { env: { GH_TOKEN: 'token-B-for-daemon-tests' } })).stdout;
    expect((JSON.parse(second) as { pid: number }).pid).not.toBe(first.pid);
  });
});

describe('exclusive servers', () => {
  it('are stopped as soon as the request is done, so the daemon holds no lock', async () => {
    const d = await daemonSandbox(config('    exclusive: true\n'));
    const a = await d.via(['mock', 'pid']);
    const status = (await d.status())!;
    await waitFor(async () => (await d.status())!.sessions[0]!.connected === false, 3000, 'the exclusive server to stop');
    await waitFor(() => !alive(Number(a.stdout.trim())), 3000, 'the exclusive server process to exit');
    expect(status.sessions[0]!.server).toBe('mock');
    const b = await d.via(['mock', 'pid']);
    expect(b.stdout).not.toBe(a.stdout);
    // Browsing needs no server process: the tool list stays.
    expect((await d.via(['mock'])).code).toBe(0);
  });
});

describe('cursors', () => {
  it('keeps truncated results in the daemon, not on disk', async () => {
    const srv = await startFixtureServer({ token: FAKE_TOKEN });
    useCleanup(() => srv.close());
    const d = await daemonSandbox(ghConfig(srv.url), { GH_TOKEN: FAKE_TOKEN });
    const first = await d.via(['gh', 'pull-request:list', '--owner', 'a', '--repo', 'b']);
    expect(first.code).toBe(0);
    const cursor = /next: via more ([0-9a-f]+)/.exec(first.stderr)?.[1];
    expect(cursor).toBeDefined();
    expect(existsSync(join(d.sb.cacheDir, 'cursors'))).toBe(false);

    const more = await d.via(['more', cursor!]);
    expect(more.code).toBe(0);
    expect(more.stdout).toContain('Pull request number');
    expect(first.stdout).not.toBe(more.stdout);

    await d.stop();
    const gone = await d.via(['more', cursor!]);
    expect(gone.code).toBe(3);
  });
});

describe('cold start', () => {
  const entryHook = fileURLToPath(new URL('../helpers/trace-imports.mjs', import.meta.url));

  /** Run the bundled CLI as its own process with an import trace for the heavy dependencies. */
  async function traced(d: Awaited<ReturnType<typeof daemonSandbox>>, argv: string[], daemon: boolean): Promise<{ code: number | null; stdout: string; loaded: string[] }> {
    const trace = join(d.runtime, `trace-${Math.random().toString(16).slice(2)}.txt`);
    const r = spawnSync(process.execPath, ['--import', entryHook, await builtCli(), ...argv], {
      encoding: 'utf8',
      cwd: d.sb.project,
      env: {
        PATH: process.env.PATH,
        HOME: d.sb.home,
        XDG_RUNTIME_DIR: d.runtime,
        VIA_NO_DAEMON: daemon ? '0' : '1',
        TRACE_FILE: trace,
        TRACE_IMPORTS: '@modelcontextprotocol/sdk,ajv,ajv-formats',
      },
      timeout: 20_000,
    });
    const loaded = existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter(Boolean) : [];
    return { code: r.status, stdout: r.stdout, loaded };
  }

  it('does not load the MCP SDK or ajv in a CLI process that goes through the daemon', async () => {
    const d = await daemonSandbox(config());
    const warm = await traced(d, ['mock', 'echo', '--message', 'warm'], true);
    expect(warm.code).toBe(0);
    expect(warm.stdout).toBe('echo: warm\n');
    for (const argv of [['mock', 'echo', '--message', 'hi'], ['mock'], ['find', 'echo'], ['mock', 'pid']]) {
      const r = await traced(d, argv, true);
      expect(r.code, argv.join(' ')).toBe(0);
      expect(r.loaded, argv.join(' ')).toEqual([]);
    }
  });

  it('does load them in-process, which proves the trace works', async () => {
    const d = await daemonSandbox(config());
    const r = await traced(d, ['mock', 'echo', '--message', 'hi'], false);
    expect(r.code).toBe(0);
    expect(r.loaded.some((s) => s.startsWith('@modelcontextprotocol/sdk'))).toBe(true);
    expect(r.loaded.some((s) => s.startsWith('ajv'))).toBe(true);
  });
});

describe('OAuth', () => {
  it('uses the login the CLI made, refreshes in the daemon, and never prints a token', async () => {
    const srv = await startOAuthServer();
    useCleanup(() => srv.close());
    const d = await daemonSandbox(`sources: false\nservers:\n  linear:\n    url: ${srv.url}\n    auth: oauth\n`);
    const browser = async (url: string) => {
      srv.browse(url).catch(() => undefined);
      return { opened: true };
    };

    // Not logged in yet: needs auth (exit 4), decided by the daemon.
    const before = await d.via(['linear', 'echo-text', '--message', 'hi']);
    expect(before.code).toBe(4);
    expect(before.stderr).toContain('next: via auth login linear');

    const login = await d.via(['auth', 'login', 'linear'], { openUrl: browser });
    expect(login.code).toBe(0);

    const call = await d.via(['linear', 'echo-text', '--message', 'hi']);
    expect(call.code).toBe(0);
    expect(call.stdout).toBe('echo: hi\n');
    expect((await d.status())!.sessions).toHaveLength(1);

    // The access token expires: the daemon's session refreshes it before the next request.
    srv.expireAccessTokens();
    const refreshed = await d.via(['linear', 'echo-text', '--message', 'again']);
    expect(refreshed.code).toBe(0);
    expect(srv.state.tokenRequests.some((t) => t.grant_type === 'refresh_token')).toBe(true);

    const whoami = await d.via(['linear', 'whoami']);
    const secrets = [...srv.issuedAccessTokens(), ...srv.issuedRefreshTokens()];
    expect(secrets.length).toBeGreaterThan(0);
    for (const r of [before, login, call, refreshed, whoami, await d.via(['daemon', 'status', '-o', 'json'])]) {
      for (const secret of secrets) {
        expect(r.stdout).not.toContain(secret);
        expect(r.stderr).not.toContain(secret);
      }
    }
    expect(whoami.stdout).toContain('***');

    // A logout made by the CLI is seen by the daemon on its next request.
    expect((await d.via(['auth', 'logout', 'linear'])).code).toBe(0);
    const after = await d.via(['linear', 'echo-text', '--message', 'hi']);
    expect(after.code).toBe(4);
  });
});
