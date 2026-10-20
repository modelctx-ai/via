// A throwaway HOME for the benchmark: a via user config that points at the replay servers and
// nothing else (`sources: false`), so a developer's framework configs, credentials and caches
// are never read. The same HOME serves mcp2cli's baked configs and caches.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Sandbox {
  root: string;
  home: string;
  /** Working directory of every command; no `.via.yaml` above it. */
  project: string;
  /** The complete environment commands run with (plus nothing inherited). */
  env: Record<string, string>;
  cleanup(): void;
}

/** @param servers provider name → replay server URL */
export function createSandbox(servers: Readonly<Record<string, string>>): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'via-bench-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(join(home, '.config', 'via'), { recursive: true });
  mkdirSync(project, { recursive: true });
  const lines = ['sources: false', 'servers:'];
  for (const [name, url] of Object.entries(servers)) lines.push(`  ${name}:`, `    url: ${url}`);
  writeFileSync(join(home, '.config', 'via', 'config.yaml'), `${lines.join('\n')}\n`);
  return {
    root,
    home,
    project,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      // Windows reads the profile variables instead of HOME / XDG_*, and its processes need SystemRoot.
      ...(process.platform === 'win32'
        ? {
            USERPROFILE: home,
            APPDATA: join(home, '.config'),
            LOCALAPPDATA: join(home, '.local', 'app'),
            ...Object.fromEntries(['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP'].flatMap((n) => (process.env[n] === undefined ? [] : [[n, process.env[n]!]]))),
          }
        : {}),
      NO_COLOR: '1',
      // The benchmark counts tokens against HTTP replays: no background process outliving its sandbox.
      VIA_NO_DAEMON: '1',
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
