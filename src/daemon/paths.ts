// Where the daemon lives (daemon.md, "生命周期"): socket, start lock and token file, and the checks
// that keep a CLI from talking to a socket somebody else planted.
import { lstatSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { userCacheDir, type PathContext } from '../config/paths';

export interface DaemonPaths {
  /** Directory holding the files below (a Windows named pipe has no directory of its own). */
  dir: string;
  /** Unix socket, or the named pipe `via-<user>` on Windows. */
  socket: string;
  /** Held while a starting daemon probes and binds, so two of them cannot steal each other's socket. */
  lock: string;
  /** Random secret the daemon writes at start; the CLI sends it in `hello`. */
  token: string;
  /** Where a detached daemon's stderr goes; read back when it fails to start. */
  log: string;
  /** True when `socket` is a named pipe. */
  pipe: boolean;
}

/**
 * Linux: `$XDG_RUNTIME_DIR/via.sock`, else the user cache directory; macOS: the user cache
 * directory; Windows: the named pipe `via-<user>` (the pipe is computed here, Windows
 * itself is a 0.3 item). `socketOverride` is `via daemon run --socket`.
 */
export function daemonPaths(ctx: PathContext, socketOverride?: string): DaemonPaths {
  if (ctx.platform === 'win32') {
    const dir = userCacheDir(ctx);
    const socket = socketOverride ?? `\\\\.\\pipe\\via-${ctx.env.USERNAME || safeUserName()}`;
    return { dir, socket, lock: join(dir, 'via.lock'), token: join(dir, 'via.token'), log: join(dir, 'via-daemon.log'), pipe: true };
  }
  const runtime = ctx.platform === 'linux' ? ctx.env.XDG_RUNTIME_DIR : undefined;
  const useRuntime = runtime !== undefined && runtime !== '' && isAbsolute(runtime);
  const socket = socketOverride ?? join(useRuntime ? runtime : userCacheDir(ctx), 'via.sock');
  return { dir: dirname(socket), socket, lock: `${socket}.lock`, token: `${socket}.token`, log: `${socket}.log`, pipe: false };
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
 * Absent files are fine here; the caller treats them as "no daemon".
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
