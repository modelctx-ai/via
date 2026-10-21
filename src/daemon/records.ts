// Every `via daemon run` process keeps a record of itself while it lives (daemon.md, "生命周期"): a
// file named after its pid in `DaemonPaths.records`, rewritten when its state changes and touched
// every few seconds. The socket only tells whether a daemon accepts connections; one that is still
// starting (not bound yet) or stopping (it has removed its socket and finishes what is in flight) is
// found here instead, so `via daemon status` can report it and `via daemon stop` can end it.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type DaemonProcessState = 'starting' | 'running' | 'stopping';

export interface DaemonProcess {
  pid: number;
  state: DaemonProcessState;
}

/** How often a daemon touches its record. */
export const RECORD_TOUCH_MS = 5000;

/**
 * A record untouched for this long is left by a process that is gone (killed before it could remove
 * it) or no longer runs its event loop. It is ignored and removed, so a pid that the system has given
 * to an unrelated process since is never signalled.
 */
export const RECORD_STALE_MS = 3 * RECORD_TOUCH_MS;

const STATES: readonly DaemonProcessState[] = ['starting', 'running', 'stopping'];

/** This process's record. Best effort: a directory that cannot be written only costs the lookup. */
export class ProcessRecord {
  private readonly file: string;

  constructor(
    private readonly dir: string,
    private readonly pid = process.pid,
  ) {
    this.file = join(dir, `${pid}.json`);
  }

  write(state: DaemonProcessState): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ pid: this.pid, state }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // see the class comment
    }
  }

  touch(): void {
    try {
      const now = new Date();
      utimesSync(this.file, now, now);
    } catch {
      // removed from under us: the next state change writes it again
    }
  }

  remove(): void {
    try {
      rmSync(this.file, { force: true });
    } catch {
      // left for a reader to drop once it is stale
    }
  }
}

/**
 * The daemon processes recorded in `dir` that are alive, other than this process (a test may run a
 * daemon in the same process as the CLI). Records of processes that are gone are removed.
 */
export function daemonProcesses(dir: string, now = Date.now()): DaemonProcess[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found: DaemonProcess[] = [];
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    const file = join(dir, name);
    let state: unknown;
    let touched: number;
    try {
      touched = statSync(file).mtimeMs;
      state = (JSON.parse(readFileSync(file, 'utf8')) as { state?: unknown }).state;
    } catch {
      continue; // removed meanwhile, or caught half-written
    }
    if (!running(pid) || now - touched > RECORD_STALE_MS) {
      try {
        rmSync(file, { force: true });
      } catch {
        // another reader got there first, or the directory is read-only: ignored either way
      }
      continue;
    }
    if (pid === process.pid || !STATES.includes(state as DaemonProcessState)) continue;
    found.push({ pid, state: state as DaemonProcessState });
  }
  return found.sort((a, b) => a.pid - b.pid);
}

/** Whether `pid` is a process this user may signal; a pid of another user's process is no daemon of ours. */
export function running(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
