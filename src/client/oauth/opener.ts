// Opening the authorization URL in a browser (auth.md, "回调"). Best effort and never blocking:
// the URL is always printed as well, a missing opener is a note and not an error, and the
// launched process is detached so a slow browser start cannot hold `via` up.
import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { getEnv, type Env } from '../../platform/env';

export interface OpenResult {
  opened: boolean;
  /** Why it was not opened, for the note shown to the user. */
  reason?: string;
}

/** Whether a browser on this machine is likely to be where the user is looking. */
export function browserUnavailable(env: Env, platform: NodeJS.Platform): string | undefined {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return 'this is an SSH session';
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return 'no display is available';
  return undefined;
}

/**
 * The program that opens `url`. On Windows this is `rundll32 url.dll,FileProtocolHandler`, started
 * directly by its full path: `cmd /c start` would hand the URL to `cmd.exe`, which parses `|`, `^`,
 * `(` and `%VAR%` in it, and the URL comes from the authorization server (not from the user).
 */
export function openerCommand(url: string, platform: NodeJS.Platform, env: Env = process.env): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') {
    const root = getEnv(env, 'SystemRoot', platform) ?? getEnv(env, 'windir', platform);
    return { command: root ? win32.join(root, 'System32', 'rundll32.exe') : 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  }
  return { command: 'xdg-open', args: [url] };
}

export async function openBrowser(url: string, env: Env = process.env, platform: NodeJS.Platform = process.platform): Promise<OpenResult> {
  const unavailable = browserUnavailable(env, platform);
  if (unavailable) return { opened: false, reason: unavailable };
  // ShellExecute (and xdg-open) would also run a file: URL or a bare path; only web pages are opened.
  if (!/^https?:\/\//i.test(url)) return { opened: false, reason: 'the URL is not an http(s) URL' };
  const { command, args } = openerCommand(url, platform, env);
  return new Promise<OpenResult>((resolve) => {
    try {
      const child = spawn(command, args, { env: { ...env }, stdio: 'ignore', detached: true, windowsHide: true });
      // 'spawn' fires once the process exists; 'error' (ENOENT, EACCES) fires instead when it cannot start.
      child.once('error', (error: NodeJS.ErrnoException) => resolve({ opened: false, reason: error.code === 'ENOENT' ? `${command} is not installed` : `cannot run ${command}` }));
      child.once('spawn', () => {
        child.unref();
        resolve({ opened: true });
      });
    } catch {
      resolve({ opened: false, reason: `cannot run ${command}` });
    }
  });
}
