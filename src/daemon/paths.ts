// Where the daemon lives (daemon.md, "生命周期"): socket, start lock and token file, and the checks
// that keep a CLI from talking to a socket somebody else planted.
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, win32 } from 'node:path';
import { getEnv, pathModule, userCacheDir, type PathContext } from '../config/paths';

export interface DaemonPaths {
  /** Directory holding the files below (a Windows named pipe has no directory of its own). */
  dir: string;
  /**
   * Unix socket, or the named pipe on Windows. For a derived pipe (`derived`) this is only the
   * prefix of the real name; use `endpointOf`.
   */
  socket: string;
  /** Held while a starting daemon probes and binds, so two of them cannot steal each other's socket. */
  lock: string;
  /** Random secret the daemon writes at start; the CLI sends it in `hello`. */
  token: string;
  /** Where a detached daemon's stderr goes; read back when it fails to start. */
  log: string;
  /**
   * Directory where every daemon process for this socket keeps a record of itself while it lives
   * (`records.ts`), so `via daemon status|stop` can find one that does not listen (yet, or any more).
   */
  records: string;
  /** True when `socket` is a named pipe. */
  pipe: boolean;
  /**
   * True when the real pipe name is `socket` plus a digest of the start token, so it cannot be known
   * (or squatted) by anyone who cannot read the token file. Only the default Windows pipe is derived;
   * `--socket` names a pipe exactly.
   */
  derived: boolean;
}

/**
 * Linux: `$XDG_RUNTIME_DIR/via.sock`, else the user cache directory; macOS: the user cache
 * directory; Windows: the named pipe `\\.\pipe\via-<user>-<digest of the token>` with the token file
 * in the user's cache directory (`%LOCALAPPDATA%\via\Cache`). `socketOverride` is `via daemon run --socket`.
 */
export function daemonPaths(ctx: PathContext, socketOverride?: string): DaemonPaths {
  if (ctx.platform === 'win32') {
    const dir = userCacheDir(ctx);
    if (socketOverride !== undefined) {
      // An explicit pipe: its files are named after it, so several daemons (tests) do not share them.
      const base = pipeBaseName(socketOverride);
      return {
        dir,
        socket: socketOverride,
        lock: win32.join(dir, `${base}.lock`),
        token: win32.join(dir, `${base}.token`),
        log: win32.join(dir, `${base}.log`),
        records: win32.join(dir, `${base}.pids`),
        pipe: true,
        derived: false,
      };
    }
    const user = pipeUserName(getEnv(ctx.env, 'USERNAME', 'win32') || safeUserName());
    return {
      dir,
      socket: `\\\\.\\pipe\\via-${user}`,
      lock: win32.join(dir, 'via.lock'),
      token: win32.join(dir, 'via.token'),
      log: win32.join(dir, 'via-daemon.log'),
      records: win32.join(dir, 'via.pids'),
      pipe: true,
      derived: true,
    };
  }
  const { join } = pathModule(ctx.platform);
  const runtime = ctx.platform === 'linux' ? ctx.env.XDG_RUNTIME_DIR : undefined;
  const useRuntime = runtime !== undefined && runtime !== '' && isAbsolute(runtime);
  const socket = socketOverride ?? join(useRuntime ? runtime : userCacheDir(ctx), 'via.sock');
  return { dir: dirname(socket), socket, lock: `${socket}.lock`, token: `${socket}.token`, log: `${socket}.log`, records: `${socket}.pids`, pipe: false, derived: false };
}

/**
 * The name to listen on or connect to. A derived pipe appends 128 bits of SHA-256 over the token:
 * the token is random per daemon start and only readable from the user's profile, so another user
 * can neither guess the name to occupy it ahead of the daemon nor learn it later from the pipe
 * namespace and use it. `token` is undefined when there is no token file, i.e. no daemon.
 */
export function endpointOf(paths: DaemonPaths, token?: string): string | undefined {
  if (!paths.derived) return paths.socket;
  if (token === undefined || token === '') return undefined;
  return `${paths.socket}-${createHash('sha256').update(`via-pipe\0${token}`).digest('hex').slice(0, 32)}`;
}

/** The name for display: a derived pipe's digest is not known without a running daemon, so it shows as `*`. */
export function describeEndpoint(paths: DaemonPaths): string {
  return paths.derived ? `${paths.socket}-*` : paths.socket;
}

/** The part of a pipe path after `\\.\pipe\`, reduced to characters that are safe in a file name. */
function pipeBaseName(pipe: string): string {
  const name = pipe.replace(/^[\\/]{2}[.?][\\/]pipe[\\/]/i, '').replace(/[^A-Za-z0-9._-]/g, '_');
  return name === '' ? 'via-pipe' : name.slice(0, 80);
}

/** A user name as a pipe-name part: letters, digits and a few separators (no backslash, which ends a pipe name). */
function pipeUserName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
  return safe === '' ? 'user' : safe;
}

function safeUserName(): string {
  try {
    return userInfo().username;
  } catch {
    return 'user';
  }
}

/**
 * Why `paths` must not be trusted, or undefined when it is fine. Node has no `SO_PEERCRED`, so the
 * guarantee that only this user reaches the daemon rests on file ownership and modes (security.md):
 * the directory must be ours and closed to others, and the socket must be ours with mode 0600.
 * Absent files are fine here; the caller treats them as "no daemon". On Windows there are no mode
 * bits to read; the token (a file in the user's profile) and the unguessable pipe name take their place.
 */
export function unsafeReason(paths: DaemonPaths): string | undefined {
  if (paths.pipe || typeof process.getuid !== 'function') return undefined;
  const uid = process.getuid();
  try {
    const dir = lstatSync(paths.dir);
    if (!dir.isDirectory() || dir.uid !== uid) return `${paths.dir} is not a directory owned by you`;
    if ((dir.mode & 0o022) !== 0) return `${paths.dir} is writable by other users`;
  } catch {
    return undefined;
  }
  try {
    const socket = lstatSync(paths.socket);
    if (!socket.isSocket() || socket.uid !== uid) return `${paths.socket} is not a socket owned by you`;
    if ((socket.mode & 0o077) !== 0) return `${paths.socket} is accessible to other users`;
  } catch {
    return undefined;
  }
  return undefined;
}
