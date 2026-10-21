import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FEATURES } from '../../scripts/lib/chunk-features';
import { startOAuthServer } from '../fixtures/mcp/oauth-server.mjs';
import { CLI_STDIO_SERVER, FAKE_TOKEN, ghConfig, startFixtureServer } from './helpers';

// The single-file executable (`npm run build:bin`, scripts/build-bin.ts) must behave exactly like
// `node dist/via.js`. When `bun` is installed this builds the binary for the host once and runs a
// smoke set against it; without Bun the suite is skipped (CI sets VIA_REQUIRE_BUN=1 so that a
// missing Bun is a failure there, not a silent skip).
const root = fileURLToPath(new URL('../..', import.meta.url));
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
const hasBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;
const windows = process.platform === 'win32';

if (!hasBun && process.env.VIA_REQUIRE_BUN) {
  it('bun is installed', () => expect(hasBun).toBe(true));
}

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe.skipIf(!hasBun || windows)('single-file executable', () => {
  let work = '';
  let bin = '';
  let home = '';

  // Unix socket paths are short (104 bytes on macOS): keep the sandbox directly below /tmp.
  const baseEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
    PATH: process.env.PATH ?? '',
    HOME: home,
    XDG_RUNTIME_DIR: join(home, 'run'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    VIA_NO_DAEMON: '1',
    VIA_OAUTH_STORE: 'file',
    // No browser may be launched by a test.
    SSH_CONNECTION: '1',
    ...extra,
  });

  function start(args: string[], options: { env?: Record<string, string>; cwd?: string; stdin?: string } = {}) {
    const child = spawn(bin, args, { cwd: options.cwd ?? home, env: baseEnv(options.env), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(options.stdin ?? '');
    const out = { stdout: '', stderr: '' };
    child.stdout.on('data', (c: Buffer) => (out.stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (out.stderr += c.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    const done = new Promise<Result>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, ...out });
      });
    });
    return { child, out, done };
  }

  const via = (args: string[], options: { env?: Record<string, string>; cwd?: string; stdin?: string } = {}): Promise<Result> => start(args, options).done;

  function userConfig(yaml: string): void {
    mkdirSync(join(home, '.config', 'via'), { recursive: true });
    writeFileSync(join(home, '.config', 'via', 'config.yaml'), yaml);
  }

  beforeAll(() => {
    mkdirSync(join(root, '.build'), { recursive: true });
    work = mkdtempSync(join(root, '.build', 'bin-'));
    const build = spawnSync('bun', [join(root, 'scripts', 'build-bin.ts'), '--out-dir', join(work, 'out')], { cwd: root, encoding: 'utf8', timeout: 180_000 });
    if (build.status !== 0) throw new Error(`build-bin failed: ${build.stderr || build.stdout}`);
    const built = readdirSync(join(work, 'out')).filter((f) => !f.endsWith('.sha256'));
    expect(built).toHaveLength(1);
    bin = join(work, 'out', built[0]!);
    home = mkdtempSync('/tmp/vb-');
  }, 240_000);

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('prints the version and help', async () => {
    expect(await via(['--version'])).toEqual({ code: 0, stdout: `${version}\n`, stderr: '' });
    const help = await via(['-h']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('usage:');
  });

  it('writes a checksum next to the binary', () => {
    const sum = readFileSync(`${bin}.sha256`, 'utf8');
    expect(sum).toMatch(/^[0-9a-f]{64} {2}via-[a-z0-9-]+\n$/);
  });

  // The rules in data/ are inlined into the executable: browse views classify a provider from them.
  it('shows the root view and a provider from the embedded data, and calls a tool over HTTP', async () => {
    const srv = await startFixtureServer({ token: FAKE_TOKEN });
    try {
      userConfig(ghConfig(srv.url));
      const root = await via([], { env: { GH_TOKEN: FAKE_TOKEN } });
      expect(root.code).toBe(0);
      expect(root.stdout).toMatch(/^1 providers? · 14 tools\n/);
      expect(root.stdout).toMatch(/\ngh +code +14 tools\n/);
      const provider = await via(['gh'], { env: { GH_TOKEN: FAKE_TOKEN } });
      expect(provider.stdout).toContain('issue         read · write · list');

      const call = await via(['gh', 'issue:read', '--owner', 'acme', '--repo', 'api', '--issue-number', '3', '--method', 'get'], { env: { GH_TOKEN: FAKE_TOKEN } });
      expect(call).toMatchObject({ code: 0, stdout: 'number: 3\ntitle: Support OAuth DCR\nstate: open\n' });
      expect(call.stderr).toMatch(/^· gh issue:read · \d+ms · 47 bytes\n$/);
      expect(call.stderr + call.stdout).not.toContain(FAKE_TOKEN);

      const invalid = await via(['gh', 'issue:read', '--owner', 'acme'], { env: { GH_TOKEN: FAKE_TOKEN } });
      expect(invalid.code).toBe(2);
    } finally {
      await srv.close();
    }
  });

  it('reads standard input (via batch)', async () => {
    const srv = await startFixtureServer({ token: FAKE_TOKEN });
    try {
      userConfig(ghConfig(srv.url));
      const line = (n: number) => JSON.stringify({ tool: 'gh/issue:read', args: { owner: 'acme', repo: 'api', issue_number: n, method: 'get' } });
      const r = await via(['batch', '-o', 'json'], { env: { GH_TOKEN: FAKE_TOKEN }, stdin: `${line(3)}\n${line(3)}\n` });
      expect(r.code).toBe(0);
      expect(r.stdout.trim().split('\n')).toHaveLength(2);
      expect(r.stdout).toContain('Support OAuth DCR');
    } finally {
      await srv.close();
    }
  });

  it('spawns and talks to a stdio server', async () => {
    userConfig(`sources: false\nservers:\n  job:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(CLI_STDIO_SERVER)}]\n`);
    const r = await via(['job', 'run_job']);
    expect(r).toMatchObject({ code: 0, stdout: 'job done\n' });
    expect(r.stderr).toContain('progress: 1/2 halfway');
  });

  // `via daemon run` is started from the binary itself (not `node`, not a path inside Bun's virtual
  // filesystem), and the next call is served by it.
  it('starts its own daemon, serves a second call from it and stops it', async () => {
    const srv = await startFixtureServer({ token: FAKE_TOKEN });
    const env = { GH_TOKEN: FAKE_TOKEN, VIA_NO_DAEMON: '0' };
    let pid: number | undefined;
    try {
      userConfig(ghConfig(srv.url));
      expect((await via(['daemon', 'status'], { env })).stdout).toContain('daemon: not running');
      const args = ['gh', 'issue:read', '--owner', 'acme', '--repo', 'api', '--issue-number', '3', '--method', 'get'];
      expect((await via(args, { env })).code).toBe(0);
      expect((await via(args, { env })).code).toBe(0);
      const status = JSON.parse((await via(['daemon', 'status', '-o', 'json'], { env })).stdout) as { running: boolean; pid: number; sessions: Array<{ server: string; calls: number }> };
      expect(status.running).toBe(true);
      pid = status.pid;
      expect(status.sessions).toMatchObject([{ server: 'gh', calls: 2 }]);
      const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
      expect(ps.stdout).toContain(`${bin} daemon run --socket`);
      expect((await via(['daemon', 'stop'], { env })).stdout).toContain('daemon: stopped');
      pid = undefined;
    } finally {
      if (pid !== undefined) process.kill(pid, 'SIGKILL');
      await srv.close();
    }
  });

  describe('keychain', () => {
    const cfg = (url: string) => `sources: false\nservers:\n  kc:\n    url: ${url}\n    auth: { bearer: "keychain:via/smoke-test-entry" }\n`;

    // The native module is embedded and loads; whether this machine has an unlocked keychain or a
    // Secret Service is another matter, so both outcomes are accepted, but neither may crash.
    it('loads the embedded module and reports a missing entry or an unreachable keychain as a credential error', async () => {
      userConfig(cfg('http://127.0.0.1:9/mcp'));
      const r = await via(['kc', 'anything']);
      expect(r.code).toBe(4);
      expect(r.stderr).toMatch(/^error: (no keychain entry for service "via", account "smoke-test-entry"|cannot read the system keychain: )/);
      expect(r.stderr).toContain('\nnext: ');
      expect(r.stderr).not.toMatch(/\n\s+at /);
      expect(r.stderr).not.toContain('native keychain module is not available');
    });

    it('tells the user to use env: or file: when the native module cannot be loaded', async () => {
      userConfig(cfg('http://127.0.0.1:9/mcp'));
      const r = await via(['kc', 'anything'], { env: { NAPI_RS_NATIVE_LIBRARY_PATH: join(work, 'no-such-keyring.node') } });
      expect(r.code).toBe(4);
      expect(r.stderr).toMatch(/^error: cannot read the system keychain: the native keychain module is not available on \w+-\w+ \(/);
      expect(r.stderr).toContain('next: use env: or file: instead');
      expect(r.stderr).not.toContain('npm');
    });
  });

  // A .env file or bunfig.toml in the current directory configures a plain `bun` process; the
  // executable is built with both autoloads off, so a project directory cannot inject credentials.
  it('does not load .env or bunfig.toml from the current directory', async () => {
    const srv = await startFixtureServer({ token: FAKE_TOKEN });
    try {
      userConfig(ghConfig(srv.url));
      const project = join(home, 'project');
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, '.env'), `GH_TOKEN=${FAKE_TOKEN}\n`);
      writeFileSync(join(project, 'bunfig.toml'), 'preload = ["./evil.ts"]\n');
      writeFileSync(join(project, 'evil.ts'), 'process.stderr.write("PRELOADED\\n");\n');
      const r = await via(['gh', 'issue:read', '--owner', 'acme', '--repo', 'api', '--issue-number', '3', '--method', 'get'], { cwd: project });
      expect(r.code).toBe(4);
      expect(r.stderr).toContain('environment variable GH_TOKEN is not set');
      expect(r.stderr).not.toContain('PRELOADED');
    } finally {
      await srv.close();
    }
  });

  // auth.md: browser flow with the loopback listener. The "browser" is the test; the executable
  // prints the authorization URL first, listens on 127.0.0.1 and exchanges the code.
  it('logs in through the OAuth loopback flow and uses the stored login', async () => {
    const srv = await startOAuthServer();
    try {
      userConfig(`sources: false\nservers:\n  linear:\n    url: ${srv.url}\n    auth: oauth\n`);
      const login = start(['auth', 'login', 'linear']);
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no authorization URL printed: ${login.out.stdout}${login.out.stderr}`)), 15_000);
        const poll = setInterval(() => {
          const line = login.out.stdout.split('\n')[0];
          if (login.out.stdout.includes('\n') && line) {
            clearInterval(poll);
            clearTimeout(timer);
            resolve(line);
          }
        }, 20);
      });
      await srv.browse(url);
      const done = await login.done;
      expect(done.code).toBe(0);
      expect(done.stdout).toContain('logged in: linear');
      const call = await via(['linear', 'issue:read', '--owner', 'acme', '--repo', 'api', '--issue-number', '3', '--method', 'get']);
      expect(call).toMatchObject({ code: 0, stdout: 'number: 3\ntitle: Support OAuth DCR\nstate: open\n' });
      for (const secret of srv.issuedAccessTokens()) expect(done.stdout + done.stderr + call.stdout + call.stderr).not.toContain(secret);
    } finally {
      await srv.close();
    }
  });

  // Cold start: the entry chunk must not statically reach the command runner or any library, or the
  // executable would parse them for `--version`. Bun's compile step embeds exactly the chunks of an
  // ordinary `--splitting` bundle, so that bundle is inspected instead of the opaque binary.
  it('keeps the entry chunk free of libraries and the command runner', () => {
    const out = join(work, 'chunks');
    const build = spawnSync('bun', ['build', join(root, 'src', 'cli', 'main.ts'), '--outdir', out, '--splitting', '--target=bun', '--format=esm'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    expect(build.status).toBe(0);
    // Static closure of the entry: itself plus the chunks it imports with `import ... from`.
    const closure = new Set<string>();
    const visit = (file: string): void => {
      if (closure.has(file)) return;
      closure.add(file);
      const text = readFileSync(join(out, file), 'utf8');
      for (const m of text.matchAll(/^\s*(?:import|export)\b[^'"(]*?\bfrom\s*["'](\.\/[^"']+)["']/gm)) visit(m[1]!.slice(2));
    };
    visit('main.js');
    const text = [...closure].map((f) => readFileSync(join(out, f), 'utf8')).join('\n');
    expect(closure.size).toBeLessThanOrEqual(3);
    expect(text.length).toBeLessThan(16_384);
    expect(FEATURES.filter(([, marker]) => marker.test(text))).toEqual([]);
    expect(readFileSync(join(out, 'main.js'), 'utf8')).toMatch(/import\(["']\.\/run-/);
  });
});
