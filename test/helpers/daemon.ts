// Harness for tests that run a real daemon: the CLI is bundled once with esbuild (a single file next
// to the repo's node_modules) so `via daemon run` can be started as a detached child, exactly as
// the CLI does it in production. Every sandbox gets its own socket directory (on Windows its own
// profile directories and pipe-name prefix), and every daemon it started is stopped (and killed if
// need be) when the test ends.
import { defaultGeneration, fixtureScript } from './generation';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll } from 'vitest';
import { run } from '../../src/cli/run';
import { pathContext, userCacheDir } from '../../src/config/paths';
import { daemonPaths, type DaemonPaths } from '../../src/daemon/paths';
import type { DaemonStatus } from '../../src/protocol';
import { makeSandbox, removeSandbox, SYSTEM_ENV, useCleanup, type CliResult, type Sandbox } from '../cli/helpers';

const root = fileURLToPath(new URL('../..', import.meta.url));
const recordPid = pathToFileURL(fileURLToPath(new URL('./record-pid.mjs', import.meta.url))).href;

let built: Promise<string> | undefined;

/** Path of a freshly bundled `via` entry; built once per test file. */
export function builtCli(): Promise<string> {
  built ??= (async () => {
    mkdirSync(join(root, '.build'), { recursive: true });
    const dir = mkdtempSync(join(root, '.build', 'daemon-'));
    const outfile = join(dir, 'via.mjs');
    await build({
      entryPoints: [join(root, 'src/cli/main.ts')],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      packages: 'external',
      logLevel: 'silent',
    });
    cleanupDirs.push(dir);
    return outfile;
  })();
  return built;
}

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(condition: () => boolean | Promise<boolean>, ms = 5000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export const isWindows = process.platform === 'win32';

export interface DaemonSandbox {
  sb: Sandbox;
  /** Short private directory: `via.sock` on Linux (`XDG_RUNTIME_DIR`), the profile directories on Windows. */
  runtime: string;
  /**
   * The socket file (macOS: in the sandbox's user cache directory); on Windows the pipe-name prefix
   * (`\\.\pipe\via-<user>`), the real name adds a digest of the token.
   */
  socket: string;
  /** Daemon files (`.token`, `.lock`, `.log`) and the platform they were computed for. */
  paths: DaemonPaths;
  platform: NodeJS.Platform;
  /** The user cache directory (catalog cache, cursors, media) of the sandbox's platform. */
  cacheDir: string;
  /** Environment for a real child process that must find this sandbox's daemon and configuration. */
  processEnv(): Record<string, string>;
  /** The text `daemon status` prints after `socket: ` when the daemon runs, as a regular expression source. */
  runningSocketPattern: string;
  /** The text it prints when no daemon runs. */
  idleSocketText: string;
  /** Run `via` with the daemon enabled and the bundled CLI as the program to start it. */
  via(argv: string[], options?: { env?: Record<string, string | undefined>; cwd?: string; stdin?: string; daemonCommand?: { command: string; args: string[] }; openUrl?: (url: string) => Promise<{ opened: boolean; reason?: string }>; answers?: string[] }): Promise<CliResult>;
  /** `via daemon status -o json`, or undefined when no daemon runs. */
  status(): Promise<DaemonStatus | undefined>;
  /** Stop the daemon and wait until its process is gone. */
  stop(): Promise<void>;
  /** Have teardown end this process too (a server the test may orphan, e.g. by killing the daemon). */
  track(pid: number): void;
}

/** A sandbox whose `via` talks to a daemon of its own. `config` is the user config (YAML). */
export async function daemonSandbox(config: string, env: Record<string, string> = {}): Promise<DaemonSandbox> {
  const entry = await builtCli();
  const sb = makeSandbox(env);
  sb.userConfig(config);
  const runtime = mkdtempSync(join(tmpdir(), 'via-rt-'));
  // Every daemon started with the default command appends its pid here (record-pid.mjs).
  const pidLog = join(runtime, 'daemon-pids');
  // The host's own platform: the daemon is a real process that computes its directories (cache,
  // cursors, OAuth logins) from `process.platform`, so the in-process CLI must agree with it.
  const platform = process.platform;
  const user = `via-test-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  // OAuth logins go to files in the sandbox, never to the real keychain.
  const sandboxEnv: Record<string, string | undefined> = isWindows
    ? {
        PATH: process.env.PATH,
        ...SYSTEM_ENV,
        // Config in <home>\.config\via (where `sb.userConfig` writes), the rest under <runtime>.
        APPDATA: join(sb.home, '.config'),
        LOCALAPPDATA: join(runtime, 'local'),
        USERNAME: user,
        USERPROFILE: sb.home,
        VIA_NO_DAEMON: '0',
        VIA_OAUTH_STORE: 'file',
        VIA_TEST_PID_LOG: pidLog,
        ...env,
      }
    : { PATH: process.env.PATH, XDG_RUNTIME_DIR: runtime, VIA_NO_DAEMON: '0', VIA_OAUTH_STORE: 'file', VIA_TEST_PID_LOG: pidLog, ...env };
  const ctx = pathContext({ home: sb.home, env: sandboxEnv, platform });
  // Linux: `<runtime>/via.sock`; macOS ignores XDG_RUNTIME_DIR and keeps it in the user cache directory.
  const paths = daemonPaths(ctx);
  const socket = paths.socket;
  // A test may plant a socket there before any daemon has made the directory.
  if (!paths.pipe) mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const cacheDir = userCacheDir(ctx);
  const processEnv = (): Record<string, string> => {
    const out: Record<string, string> = { HOME: sb.home };
    for (const [name, value] of Object.entries(sandboxEnv)) if (value !== undefined) out[name] = value;
    return out;
  };
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const via: DaemonSandbox['via'] = async (argv, options = {}) => {
    let stdout = '';
    let stderr = '';
    let combined = '';
    const asked: string[] = [];
    const code = await run(argv, {
      // A person at a terminal who types these answers, one per question (a server's question during a call).
      ...(options.answers ? { interactive: true, ask: async (question: string) => (asked.push(question), options.answers!.shift() ?? '') } : {}),
      env: { ...sandboxEnv, ...options.env },
      cwd: options.cwd ?? sb.project,
      home: sb.home,
      platform,
      stdout: { write: (s) => void ((stdout += s), (combined += s)) },
      stderr: { write: (s) => void ((stderr += s), (combined += s)) },
      readStdin: async () => options.stdin ?? '',
      daemonCommand: options.daemonCommand ?? { command: process.execPath, args: ['--import', recordPid, entry] },
      ...(options.openUrl ? { openUrl: options.openUrl } : {}),
    });
    return { code, stdout, stderr, asked, combined };
  };

  // Every daemon and server process this sandbox has seen. A test may kill the daemon on purpose;
  // its stdio servers then outlive it with the sandbox as their working directory, and on Windows
  // such a directory cannot be removed (EBUSY), so teardown ends whatever is left.
  const seen = new Set<number>();
  const status = async (): Promise<DaemonStatus | undefined> => {
    const r = await via(['daemon', 'status', '-o', 'json']);
    const parsed = JSON.parse(r.stdout) as { running: boolean } & DaemonStatus;
    if (!parsed.running) return undefined;
    seen.add(parsed.pid);
    for (const session of parsed.sessions) if (session.pid) seen.add(session.pid);
    return parsed;
  };
  const recorded = (): number[] => {
    try {
      return readFileSync(pidLog, 'utf8').split('\n').filter(Boolean).map(Number);
    } catch {
      return [];
    }
  };

  /** Kill whichever of `pids` still run and wait for them; a process that will not go fails the test by name. */
  const end = async (pids: Iterable<number>): Promise<void> => {
    const left = [...new Set(pids)].filter(alive);
    for (const pid of left) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone in the meantime
      }
    }
    await Promise.all(left.map((pid) => waitFor(() => !alive(pid), 5000, `process ${pid} to exit`)));
  };

  const stop = async (): Promise<void> => {
    // Ask the daemon first: it closes its servers itself. `status` can fail (a test broke the token,
    // a killed daemon's pipe is going away), and then the processes are ended directly rather than
    // left holding the sandbox.
    let current: DaemonStatus | undefined;
    try {
      current = await status();
    } catch {
      current = undefined;
    }
    if (current) {
      await via(['daemon', 'stop']);
      await waitFor(() => !alive(current.pid), 3000, 'the daemon to exit').catch(() => undefined);
    }
    // Daemons before their servers: a stdio server whose daemon is gone sees its stdin close and exits.
    await end(recorded());
    await end(seen);
    writeFileSync(pidLog, '');
    seen.clear();
  };
  // Registered after the sandbox's own cleanup, so it runs first: every process that could hold
  // the sandbox as its working directory is gone before the directory is removed.
  useCleanup(async () => {
    try {
      await stop();
    } finally {
      await removeSandbox(runtime);
    }
  });
  return {
    sb,
    runtime,
    socket,
    paths,
    platform,
    cacheDir,
    processEnv,
    runningSocketPattern: isWindows ? `${escape(socket)}-[0-9a-f]{32}` : escape(socket),
    idleSocketText: isWindows ? `${socket}-*` : socket,
    via,
    status,
    stop,
    track: (pid) => void seen.add(pid),
  };
}

/** The stdio mock server as a `servers:` entry for the user config. */
export function mockServerYaml(name = 'mock', extra = ''): string {
  const server = fixtureScript('stdio-server', defaultGeneration());
  return `  ${name}:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(server)}]\n${extra}`;
}

/** Processes still running whose command line contains `needle` (to prove nothing leaked). */
export function pgrep(needle: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', needle], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}
