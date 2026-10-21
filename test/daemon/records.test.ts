// Records of daemon processes (daemon.md, "生命周期"): how `via daemon status|stop` find a daemon
// that does not listen on the socket (still starting, or finishing its requests after `shutdown`).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { daemonProcesses, ProcessRecord, RECORD_STALE_MS } from '../../src/daemon/records';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'via-rec-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'via.sock.pids');
}

function sleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  cleanups.push(() => void child.kill('SIGKILL'));
  return child;
}

describe('daemon process records', () => {
  it('lists the live daemon processes with their state, never this process', () => {
    const dir = scratch();
    const child = sleeper();
    new ProcessRecord(dir, child.pid!).write('stopping');
    new ProcessRecord(dir).write('running');
    expect(daemonProcesses(dir)).toEqual([{ pid: child.pid, state: 'stopping' }]);
  });

  it('removes the records of processes that are gone, or that stopped touching theirs', () => {
    const dir = scratch();
    const child = sleeper();
    const record = new ProcessRecord(dir, child.pid!);
    record.write('running');
    const old = new Date(Date.now() - RECORD_STALE_MS - 1000);
    utimesSync(join(dir, `${child.pid}.json`), old, old);
    // A pid that could belong to anything by now is not signalled: its record is dropped.
    expect(daemonProcesses(dir)).toEqual([]);
    expect(existsSync(join(dir, `${child.pid}.json`))).toBe(false);

    record.write('running');
    record.touch();
    expect(daemonProcesses(dir)).toHaveLength(1);
    child.kill('SIGKILL');
    return new Promise<void>((resolve) => {
      child.once('exit', () => {
        expect(daemonProcesses(dir)).toEqual([]);
        expect(readdirSync(dir)).toEqual([]);
        resolve();
      });
    });
  });

  it('ignores what is not a record, and a directory that does not exist', () => {
    const dir = scratch();
    expect(daemonProcesses(dir)).toEqual([]);
    const child = sleeper();
    new ProcessRecord(dir, child.pid!).write('starting');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, `${child.pid}.json.tmp`), '{');
    expect(daemonProcesses(dir)).toEqual([{ pid: child.pid, state: 'starting' }]);
    new ProcessRecord(dir, child.pid!).remove();
    expect(daemonProcesses(dir)).toEqual([]);
  });
});
