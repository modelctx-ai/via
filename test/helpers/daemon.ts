// Harness for tests that run a real daemon: the CLI is bundled once with esbuild (a single file next
// to the repo's node_modules) so `via daemon run` can be started as a detached child, exactly as
// the CLI does it in production. Every sandbox gets its own socket directory, and every daemon it
// started is stopped (and killed if need be) when the test ends.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach } from 'vitest';
import { run } from '../../src/cli/run';
import type { DaemonStatus } from '../../src/protocol';
import { makeSandbox, type CliResult, type Sandbox } from '../cli/helpers';

const root = fileURLToPath(new URL('../..', import.meta.url));

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

export interface DaemonSandbox {
  sb: Sandbox;
  /** Short private directory holding `via.sock` (`XDG_RUNTIME_DIR`). */
  runtime: string;
  socket: string;
  /** Run `via` with the daemon enabled and the bundled CLI as the program to start it. */
  via(argv: string[], options?: { env?: Record<string, string | undefined>; cwd?: string; daemonCommand?: { command: string; args: string[] }; openUrl?: (url: string) => Promise<{ opened: boolean; reason?: string }> }): Promise<CliResult>;
  /** `via daemon status -o json`, or undefined when no daemon runs. */
  status(): Promise<DaemonStatus | undefined>;
  /** Stop the daemon and wait until its process is gone. */
  stop(): Promise<void>;
}

const tracked: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const stop of tracked.splice(0)) await stop();
});

/** A sandbox whose `via` talks to a daemon of its own. `config` is the user config (YAML). */
export async function daemonSandbox(config: string, env: Record<string, string> = {}): Promise<DaemonSandbox> {
  const entry = await builtCli();
  const sb = makeSandbox(env);
  sb.userConfig(config);
  const runtime = mkdtempSync(join(tmpdir(), 'via-rt-'));
  const socket = join(runtime, 'via.sock');
  // OAuth logins go to files in the sandbox, never to the real keychain.
  const sandboxEnv = { PATH: process.env.PATH, XDG_RUNTIME_DIR: runtime, VIA_NO_DAEMON: '0', VIA_OAUTH_STORE: 'file', ...env };

  const via: DaemonSandbox['via'] = async (argv, options = {}) => {
    let stdout = '';
    let stderr = '';
    let combined = '';
    const code = await run(argv, {
      env: { ...sandboxEnv, ...options.env },
      cwd: options.cwd ?? sb.project,
      home: sb.home,
      platform: 'linux',
      stdout: { write: (s) => void ((stdout += s), (combined += s)) },
      stderr: { write: (s) => void ((stderr += s), (combined += s)) },
      readStdin: async () => '',
      daemonCommand: options.daemonCommand ?? { command: process.execPath, args: [entry] },
      ...(options.openUrl ? { openUrl: options.openUrl } : {}),
    });
    return { code, stdout, stderr, asked: [], combined };
  };

  const status = async (): Promise<DaemonStatus | undefined> => {
    const r = await via(['daemon', 'status', '-o', 'json']);
    const parsed = JSON.parse(r.stdout) as { running: boolean } & DaemonStatus;
    return parsed.running ? parsed : undefined;
  };

  const stop = async (): Promise<void> => {
    const current = await status();
    if (current) {
      await via(['daemon', 'stop']);
      try {
        await waitFor(() => !alive(current.pid), 3000, 'the daemon to exit');
      } catch {
        process.kill(current.pid, 'SIGKILL');
      }
      for (const session of current.sessions) if (session.pid && alive(session.pid)) process.kill(session.pid, 'SIGKILL');
    }
  };
  tracked.push(async () => {
    await stop().catch(() => undefined);
    rmSync(runtime, { recursive: true, force: true });
  });
  return { sb, runtime, socket, via, status, stop };
}

/** The stdio mock server as a `servers:` entry for the user config. */
export function mockServerYaml(name = 'mock', extra = ''): string {
  const server = fileURLToPath(new URL('../fixtures/mcp/stdio-server.mjs', import.meta.url));
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
