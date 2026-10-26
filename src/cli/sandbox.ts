// Running via inside a sandbox program (ADR 0027): with `sandbox.enabled`, `via <args>` is
// `srt --settings <file> -- <node> <via> <args>`. via does not load srt as a library; it starts
// whatever program `sandbox.command` names, with srt's command line. The via inside does all the
// work in its own process (no daemon: a daemon cannot outlive the sandbox of one command) and is
// told by `VIA_SANDBOXED=1` not to wrap itself again.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtin } from '../builtin';
import { pathContext, userCacheDir, userConfigDir, userDataDir } from '../config/paths';
import type { SandboxSettings } from '../config/policy';
import { planSpawn } from '../platform/command';
import { ExitCode } from '../render/exit-codes';
import { sha256Hex } from '../sha256';
import type { CliEnv } from './env';
import { fail } from './failure';
import { SANDBOX_MARKER } from './policy';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The directories via adds to the sandbox settings. */
export interface SandboxDirs {
  /** Written by via inside the sandbox: catalog and view caches, cursors, media, logs, task records. */
  cache: string;
  /** Written too: OAuth logins kept in files (auth.md, "存储"), so a refreshed token is not lost. */
  oauth: string;
  /** Never written from inside: via's own configuration (it holds `sandbox` itself)... */
  config: string;
  /** ...and the trust records, so nothing in the sandbox can trust a project for the next run. */
  trust: string;
}

export function sandboxDirs(io: Pick<CliEnv, 'env' | 'home' | 'platform'>): SandboxDirs {
  const ctx = pathContext({ home: io.home, env: io.env, platform: io.platform });
  const data = userDataDir(ctx);
  return { cache: userCacheDir(ctx), oauth: join(data, 'oauth'), config: userConfigDir(ctx), trust: join(data, 'trust.json') };
}

function readPolicyFile(file: string): Json {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw fail(ExitCode.Usage, `sandbox.policy: cannot read ${file} (${(error as NodeJS.ErrnoException).code ?? 'read error'})`, 'via doctor');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw fail(ExitCode.Usage, `sandbox.policy: ${file} is not JSON`, 'via doctor');
  }
  if (!isObject(value)) throw fail(ExitCode.Usage, `sandbox.policy: ${file} must hold a JSON object`, 'via doctor');
  return value;
}

/**
 * The settings handed to the sandbox program: the user's `sandbox.policy` as written, plus the
 * entries via needs to work and to keep its own configuration out of reach. This is the only place
 * that knows the shape of srt's settings (`network`, `filesystem.allowWrite`, `filesystem.denyWrite`).
 */
export function sandboxSettings(settings: SandboxSettings, dirs: SandboxDirs): Json {
  const base: Json = settings.policy === undefined ? {} : 'inline' in settings.policy ? structuredClone(settings.policy.inline) : readPolicyFile(settings.policy.file);
  const network: Json = isObject(base.network) ? { ...base.network } : {};
  network.allowedDomains ??= [];
  network.deniedDomains ??= [];
  const filesystem: Json = isObject(base.filesystem) ? { ...base.filesystem } : {};
  filesystem.denyRead ??= [];
  filesystem.allowWrite = [...list(filesystem.allowWrite), dirs.cache, dirs.oauth];
  filesystem.denyWrite = [...list(filesystem.denyWrite), dirs.config, dirs.trust];
  return { ...base, network, filesystem };
}

/** Write the settings where the sandbox program can read them: one file per content, in via's cache. */
function writeSettings(dirs: SandboxDirs, settings: Json): string {
  const text = `${JSON.stringify(settings, null, 2)}\n`;
  const dir = join(dirs.cache, 'sandbox');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `settings-${sha256Hex(text).slice(0, 16)}.json`);
  try {
    writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return file;
}

function notInstalled(program: string): Error {
  return fail(ExitCode.Upstream, `cannot start the sandbox: ${program} was not found`, `ask the user: ${program} is not installed (needed by sandbox.enabled in the via config)`);
}

/**
 * Run `argv` (the whole command line as typed) in the sandbox and return its exit code. With the
 * real terminal the child shares it (questions, colours, Ctrl-C); otherwise (`via serve`, tests) its
 * output is copied into `io` and its stdin is what `io` reads.
 */
export async function runSandboxed(io: CliEnv, settings: SandboxSettings, argv: readonly string[]): Promise<number> {
  const dirs = sandboxDirs(io);
  const file = writeSettings(dirs, sandboxSettings(settings, dirs));
  const [program, ...before] = settings.command as [string, ...string[]];
  const self = io.daemonCommand;
  const args = [...before, '--settings', file, '--', self.command, ...self.args, ...argv];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(io.env)) if (value !== undefined) env[key] = value;
  env[SANDBOX_MARKER] = '1';
  // A daemon started inside would end with this command's sandbox (srt runs it with --die-with-parent).
  env.VIA_NO_DAEMON = '1';
  const planned = planSpawn(program, args, { env, cwd: io.cwd, platform: io.platform });
  if (!planned.ok) {
    if (planned.reason === 'not-found') throw notInstalled(program);
    throw fail(ExitCode.Upstream, `cannot start the sandbox: ${program} ${planned.message}`, 'ask the user: fix sandbox.command in the via config');
  }
  const { spawn } = builtin<typeof import('node:child_process')>('node:child_process');
  const inherit = io.inheritStdio === true;
  const child = spawn(planned.plan.command, planned.plan.args, {
    cwd: io.cwd,
    env,
    stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    windowsVerbatimArguments: planned.plan.windowsVerbatimArguments,
  });
  // The terminal's Ctrl-C reaches the whole process group; the sandbox program passes it on and
  // its exit code is the answer, so this process waits for it instead of dying first.
  const ignore = (): void => undefined;
  if (inherit) {
    process.on('SIGINT', ignore);
    process.on('SIGTERM', ignore);
  } else {
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => io.stdout.write(chunk));
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => io.stderr.write(chunk));
    child.stdin!.on('error', () => undefined);
    child.stdin!.end(await io.readStdin());
  }
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', (error: NodeJS.ErrnoException) => reject(error.code === 'ENOENT' ? notInstalled(program) : error));
      child.once('close', (code, signal) => {
        if (code !== null) resolve(code);
        else resolve(128 + (signal ? (builtin<typeof import('node:os')>('node:os').constants.signals[signal] ?? 0) : 0));
      });
    });
  } finally {
    if (inherit) {
      process.off('SIGINT', ignore);
      process.off('SIGTERM', ignore);
    }
  }
}
