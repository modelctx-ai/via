// Starting programs on Windows (security.md, "Windows 上的子进程").
//
// Node's `spawn` runs `.exe` and `.com` files only. `npx`, `npm`, `az`, `op` (when installed as a
// shim) and most other launchers are `.cmd` / `.bat` files, which Node (since the CVE-2024-27980
// fix) refuses to start without a shell. Going through `cmd.exe` is where "BatBadBut" lives: cmd
// re-parses the command line, so an argument can smuggle in `&`, `|` or `%VAR%` expansions.
//
// Two rules keep that closed:
//  1. A program name is resolved here, from PATH and PATHEXT only. Never from the current
//     directory, which on Windows is searched first by CreateProcess, `cmd.exe` and `which`, and is
//     a repository the user does not necessarily trust.
//  2. A batch file is run as `cmd.exe /d /v:off /s /c "<file> <args>"` with every word in double
//     quotes (so `& | < > ^ ( )` are literal) and any argument that cannot be quoted safely
//     (a double quote, `%`, a line break, NUL) is refused instead of escaped.
//
// Everything is pure and takes the platform as input, so it is tested on any host.
import { statSync } from 'node:fs';
import { getEnv, pathModule, type Env } from '../config/paths';

export interface ResolveOptions {
  env: Env;
  /** Base for a program given with a relative path (`.\tools\op.exe`); never searched for a bare name. */
  cwd: string;
  platform: NodeJS.Platform;
  /** Whether a path is a regular file; the file system by default. */
  isFile?: (path: string) => boolean;
}

const DEFAULT_PATHEXT = ['.com', '.exe', '.bat', '.cmd'];

/** How a resolved file is started: directly, through `cmd.exe`, or not at all. */
export type ProgramKind = 'exe' | 'batch' | 'other';

export function programKind(file: string): ProgramKind {
  const ext = /\.[^.\\/]*$/.exec(file)?.[0]?.toLowerCase();
  if (ext === '.exe' || ext === '.com') return 'exe';
  if (ext === '.cmd' || ext === '.bat') return 'batch';
  return 'other';
}

/** `PATHEXT` as a lower-case list; the Windows default when it is unset or empty. */
export function executableExtensions(env: Env, platform: NodeJS.Platform = 'win32'): string[] {
  const raw = getEnv(env, 'PATHEXT', platform);
  const list = (raw ?? '')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith('.') && e.length > 1);
  return list.length > 0 ? list : DEFAULT_PATHEXT;
}

/** Directories of `PATH`: absolute entries only, quotes removed. A relative entry (`.`) would bring the current directory back. */
export function searchDirectories(env: Env, platform: NodeJS.Platform = 'win32'): string[] {
  const { isAbsolute } = pathModule(platform);
  return (getEnv(env, 'PATH', platform) ?? '')
    .split(';')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d !== '' && isAbsolute(d));
}

function statIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The file `program` names on Windows, or undefined. A name with a path (`C:\tools\op`, `.\op`,
 * `tools/op`) is looked up exactly there; a bare name (`npx`) in the `PATH` directories only. When
 * the name has no extension from `PATHEXT`, each of them is tried in order, as `cmd.exe` does.
 */
export function resolveWindowsProgram(program: string, options: ResolveOptions): string | undefined {
  const pm = pathModule('win32');
  const isFile = options.isFile ?? statIsFile;
  if (program === '' || /[\0"<>|*?]/.test(program)) return undefined;
  const extensions = executableExtensions(options.env, options.platform);
  const typed = extensions.includes(/\.[^.\\/]*$/.exec(program)?.[0]?.toLowerCase() ?? '');
  const names = typed ? [program] : extensions.map((ext) => `${program}${ext}`);
  const hasPath = /[\\/]/.test(program) || /^[A-Za-z]:/.test(program);
  const directories = hasPath ? [''] : searchDirectories(options.env, options.platform);
  for (const dir of directories) {
    for (const name of names) {
      const candidate = hasPath ? pm.resolve(options.cwd, name) : pm.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

// Batch files -------------------------------------------------------------------------------------

/** Characters that cannot be carried through `cmd.exe` inside double quotes. */
const UNSAFE_FOR_CMD = /["%\r\n\0]/;

/**
 * Why `args` cannot be passed to a batch file, or undefined. The message names the problem and
 * never the argument: it may be a credential.
 */
export function batchArgumentProblem(args: readonly string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (/[\r\n\0]/.test(arg)) return `argument ${index + 1} contains a line break or NUL, which cmd.exe cannot carry`;
    if (arg.includes('"')) return `argument ${index + 1} contains a double quote, which cannot be passed safely through cmd.exe`;
    if (arg.includes('%')) return `argument ${index + 1} contains "%", which cmd.exe would expand as an environment variable`;
  }
  return undefined;
}

/** One word in double quotes; a trailing run of backslashes is doubled so it cannot escape the closing quote. */
export function quoteForCmd(word: string): string {
  return `"${word.replace(/\\+$/, (run) => run + run)}"`;
}

/** The `cmd.exe` binary: `%ComSpec%` when it really is a `cmd.exe`, else the one under `%SystemRoot%`. */
export function commandInterpreter(env: Env, platform: NodeJS.Platform = 'win32'): string {
  const { basename, join } = pathModule('win32');
  const comspec = getEnv(env, 'ComSpec', platform);
  if (comspec && pathModule('win32').isAbsolute(comspec) && basename(comspec).toLowerCase() === 'cmd.exe') return comspec;
  const root = getEnv(env, 'SystemRoot', platform) ?? getEnv(env, 'windir', platform);
  return root ? join(root, 'System32', 'cmd.exe') : 'cmd.exe';
}

export interface SpawnPlan {
  command: string;
  args: string[];
  /** Pass to `spawn`: the arguments are already a finished command line and must not be quoted again. */
  windowsVerbatimArguments: boolean;
  /** What the program name resolved to (the batch file, not `cmd.exe`). */
  resolved: string;
}

export type PlanResult =
  | { ok: true; plan: SpawnPlan }
  | { ok: false; reason: 'not-found' | 'unsupported' | 'unsafe'; message: string };

/**
 * How to start `program args…` without a shell of ours. Off Windows the program is left to the
 * operating system as is. On Windows: an `.exe` / `.com` is started directly by its full path; a
 * `.cmd` / `.bat` through `cmd.exe` as described at the top of this file; anything else is refused.
 */
export function planSpawn(program: string, args: readonly string[], options: ResolveOptions): PlanResult {
  if (options.platform !== 'win32') {
    return { ok: true, plan: { command: program, args: [...args], windowsVerbatimArguments: false, resolved: program } };
  }
  const resolved = resolveWindowsProgram(program, options);
  if (resolved === undefined) return { ok: false, reason: 'not-found', message: 'was not found in PATH' };
  const kind = programKind(resolved);
  if (kind === 'exe') return { ok: true, plan: { command: resolved, args: [...args], windowsVerbatimArguments: false, resolved } };
  if (kind === 'other') {
    return { ok: false, reason: 'unsupported', message: `resolves to ${resolved}, which is not an .exe, .com, .cmd or .bat file` };
  }
  if (UNSAFE_FOR_CMD.test(resolved)) return { ok: false, reason: 'unsafe', message: 'is installed at a path that cannot be passed safely through cmd.exe' };
  const problem = batchArgumentProblem(args);
  if (problem) return { ok: false, reason: 'unsafe', message: `is a batch file, and ${problem}` };
  const line = [resolved, ...args].map(quoteForCmd).join(' ');
  return {
    ok: true,
    plan: { command: commandInterpreter(options.env, options.platform), args: ['/d', '/v:off', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true, resolved },
  };
}

/**
 * For a stdio server: the MCP SDK starts children through `cross-spawn`, which already runs `.cmd`
 * shims by way of `cmd.exe` with its own escaping, but resolves a bare name from the working
 * directory first and turns a missing program into a `cmd.exe` error message. Resolving here
 * gives it an absolute path (so nothing is searched) and the error a person can act on. Batch
 * files get the same argument check as above. Off Windows nothing changes.
 */
export function prepareStdioCommand(
  command: string,
  args: readonly string[],
  options: ResolveOptions,
): { ok: true; command: string } | { ok: false; code: 'ENOENT' | 'EINVAL'; message: string } {
  if (options.platform !== 'win32') return { ok: true, command };
  const resolved = resolveWindowsProgram(command, options);
  if (resolved === undefined) return { ok: false, code: 'ENOENT', message: `${command} was not found in PATH` };
  const kind = programKind(resolved);
  if (kind === 'other') return { ok: false, code: 'EINVAL', message: `${command} resolves to ${resolved}, which is not an .exe, .com, .cmd or .bat file` };
  if (kind === 'batch') {
    const problem = UNSAFE_FOR_CMD.test(resolved) ? 'it is installed at a path that cannot be passed safely through cmd.exe' : batchArgumentProblem(args);
    if (problem) return { ok: false, code: 'EINVAL', message: `${command} is a batch file (${resolved}); ${problem}` };
  }
  return { ok: true, command: resolved };
}
