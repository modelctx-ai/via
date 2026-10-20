// Opening the authorization URL in a browser (auth.md, "回调"). Best effort and never blocking:
// the URL is always printed as well, a missing opener is a note and not an error, and the
// launched process is detached so a slow browser start cannot hold `via` up.
import { spawn } from 'node:child_process';
import type { Env } from '../../config/paths';

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

export function openerCommand(url: string, platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  // `start` is a cmd builtin; `&` would end the command, so it is escaped. The empty string is the window title.
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '""', url.replace(/&/g, '^&')] };
  return { command: 'xdg-open', args: [url] };
}

export async function openBrowser(url: string, env: Env = process.env, platform: NodeJS.Platform = process.platform): Promise<OpenResult> {
  const unavailable = browserUnavailable(env, platform);
  if (unavailable) return { opened: false, reason: unavailable };
  const { command, args } = openerCommand(url, platform);
  return new Promise<OpenResult>((resolve) => {
    try {
      const child = spawn(command, args, { env: { ...env }, stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: platform === 'win32' });
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
