// The log files (daemon.md "日志", ADR 0022): writing without waiting, rotation, permissions, redaction before
// anything is written, and reading back.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOG_KEEP, LOG_MAX_LINE, LOG_RETENTION_MS, LogFile, ServerLog, closeLogs, plain, pruneLogs, rotatedPaths, serverLogPath } from '../../src/log';
import { followLog, parseDuration, parseLine, readLog, type LogLine } from '../../src/log/read';
import { createRedactor } from '../../src/render/redact';
import { removeSandbox } from '../cli/helpers';

const dirs: string[] = [];
afterEach(async () => {
  await closeLogs();
  for (const dir of dirs.splice(0)) await removeSandbox(dir);
});
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'via-log-'));
  dirs.push(dir);
  return dir;
}

const SECRET = 'sk-live-0123456789abcdef';
const T0 = Date.parse('2026-10-21T10:00:00.000Z');

describe('LogFile', () => {
  it('queues a line without touching the disk, and writes it on flush', async () => {
    const path = join(tmp(), 'logs', 'a.log');
    const file = new LogFile(path, { now: () => T0 });
    file.append('event', 'hello');
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(path, '..'))).toBe(false);
    await file.flush();
    expect(readFileSync(path, 'utf8')).toBe('2026-10-21T10:00:00.000Z event  hello\n');
  });

  it('writes by itself shortly after, without a flush', async () => {
    const path = join(tmp(), 'a.log');
    const file = new LogFile(path);
    file.append('event', 'late');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(readFileSync(path, 'utf8')).toContain('late');
  });

  it.skipIf(process.platform === 'win32')('creates the directory 0700 and the file 0600', async () => {
    const root = tmp();
    const path = join(root, 'logs', 'servers', 'a.log');
    const file = new LogFile(path);
    file.append('event', 'x');
    await file.flush();
    expect(statSync(join(root, 'logs')).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'logs', 'servers')).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('rotates by size and keeps a fixed number of copies, newest first', async () => {
    const path = join(tmp(), 'a.log');
    const file = new LogFile(path, { maxBytes: 200, keep: 2 });
    for (let i = 0; i < 12; i += 1) {
      file.append('event', `line ${String(i).padStart(2, '0')} ${'x'.repeat(40)}`);
      await file.flush();
    }
    await file.close();
    expect(readdirSync(join(path, '..')).sort()).toEqual(['a.log', 'a.log.1', 'a.log.2']);
    for (const f of ['a.log', 'a.log.1', 'a.log.2']) expect(statSync(join(path, '..', f)).size).toBeLessThanOrEqual(200);
    // newest last in the live file, the older ones in .1 and .2
    expect(readFileSync(path, 'utf8')).toContain('line 11');
    expect(readFileSync(`${path}.1`, 'utf8')).toContain('line 09');
    expect(readFileSync(`${path}.2`, 'utf8')).toContain('line 07');
    expect(readFileSync(`${path}.2`, 'utf8')).not.toContain('line 05');
  });

  it('picks a file left by an earlier process up where it was', async () => {
    const path = join(tmp(), 'a.log');
    writeFileSync(path, 'old line\n'.repeat(15));
    const file = new LogFile(path, { maxBytes: 150, keep: 1 });
    file.append('event', 'new');
    await file.close();
    expect(readFileSync(`${path}.1`, 'utf8')).toContain('old line');
    expect(readFileSync(path, 'utf8')).toContain('new');
  });

  it('gives up silently when it cannot write, instead of failing anything', async () => {
    const root = tmp();
    writeFileSync(join(root, 'plain-file'), '');
    const file = new LogFile(join(root, 'plain-file', 'logs', 'a.log'));
    file.append('event', 'lost');
    await expect(file.flush()).resolves.toBeUndefined();
    file.append('event', 'ignored');
    await expect(file.close()).resolves.toBeUndefined();
  });

  it('flushSync writes what is queued for a process that is exiting', () => {
    const path = join(tmp(), 'logs', 'a.log');
    const file = new LogFile(path);
    file.append('event', 'last words');
    file.flushSync();
    expect(readFileSync(path, 'utf8')).toContain('last words');
  });
});

describe('ServerLog', () => {
  const make = (extra: string[] = [SECRET]) => {
    const path = join(tmp(), 'a.log');
    const log = new ServerLog(new LogFile(path, { now: () => T0 }), createRedactor(extra));
    return { log, text: async () => (await log.flush(), readFileSync(path, 'utf8')) };
  };

  it('writes stderr lines once they are complete, with the time and a tag', async () => {
    const { log, text } = make();
    log.stderr('first\nsec');
    log.stderr('ond\r\nthird');
    expect(await text()).toBe(['2026-10-21T10:00:00.000Z stderr first', '2026-10-21T10:00:00.000Z stderr second', '2026-10-21T10:00:00.000Z stderr third', ''].join('\n'));
  });

  it('redacts a credential the child printed, also when it arrives in two pieces', async () => {
    const { log, text } = make();
    log.stderr(`token=${SECRET.slice(0, 10)}`);
    log.stderr(`${SECRET.slice(10)} done\n`);
    log.stderr(`and as JSON: ${JSON.stringify({ k: SECRET })}\n`);
    const out = await text();
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(SECRET.slice(0, 10));
    expect(out).toContain('token=*** done');
  });

  it('replaces even a short credential in a child\'s output (content), but only long ones in event lines', async () => {
    const { log, text } = make(['abc']);
    log.stderr('say abc now\n');
    log.event('abc stays in a line via composed');
    const out = await text();
    expect(out).toContain('stderr say *** now');
    expect(out).toContain('event  abc stays in a line via composed');
  });

  it('writes control characters and escape sequences as visible escapes, so a line stays a line', async () => {
    const { log, text } = make();
    log.stderr('a\u001b[31mred\u001b[0m \u0007bell ‮flip\n');
    log.event('two\nlines\u0000');
    const out = await text();
    expect(out).toContain('stderr a\\x1b[31mred\\x1b[0m \\x07bell \\u202eflip');
    expect(out).toContain('event  two\\x0alines\\x00');
    expect(out.split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('cuts a long line after redacting it', async () => {
    const { log, text } = make();
    log.stderr(`${'x'.repeat(LOG_MAX_LINE - 5)}${SECRET}${'y'.repeat(100)}\n`);
    const out = await text();
    expect(out).not.toContain(SECRET.slice(0, 8));
    expect(out).toContain('more characters)');
    expect(out.length).toBeLessThan(LOG_MAX_LINE + 200);
  });

  it('drops the end of a line that never ends, where a credential may begin, and skips the rest of it', async () => {
    const { log, text } = make();
    log.stderr('z'.repeat(20_000 - SECRET.length / 2));
    log.stderr(`${SECRET}\nnext line\n`);
    const out = await text();
    expect(out).not.toContain(SECRET.slice(0, 8));
    expect(out).toContain('stderr next line');
    expect(out.length).toBeLessThan(5000 + 200);
  });

  it('serverLogPath keeps a plain name and tells apart names that need changing', () => {
    expect(serverLogPath('/l', 'github')).toBe(join('/l', 'servers', 'github.log'));
    expect(serverLogPath('/l', 'my.server-2')).toBe(join('/l', 'servers', 'my.server-2.log'));
    const a = serverLogPath('/l', '../etc/passwd');
    const b = serverLogPath('/l', '..\\etc\\passwd');
    expect(a).not.toBe(b);
    expect(a.startsWith(join('/l', 'servers'))).toBe(true);
    expect(a).not.toContain('..');
    expect(serverLogPath('/l', 'con')).toMatch(/con~[0-9a-f]{8}\.log$/);
    expect(serverLogPath('/l', 'with space')).toMatch(/with_space~[0-9a-f]{8}\.log$/);
    expect(serverLogPath('/l', '')).toMatch(/server~[0-9a-f]{8}\.log$/);
  });

  it('plain leaves tabs and printable text alone', () => {
    expect(plain('a\tb ü 日本')).toBe('a\tb ü 日本');
  });
});

describe('pruneLogs', () => {
  it('removes logs nobody wrote to for two weeks, and nothing else', async () => {
    const root = tmp();
    mkdirSync(join(root, 'servers'), { recursive: true });
    const old = new Date(Date.now() - LOG_RETENTION_MS - 60_000);
    for (const f of ['daemon.log', 'daemon.log.1', 'servers/gone.log']) {
      writeFileSync(join(root, f), 'x');
      utimesSync(join(root, f), old, old);
    }
    writeFileSync(join(root, 'servers', 'live.log'), 'x');
    writeFileSync(join(root, 'notes.txt'), 'x');
    utimesSync(join(root, 'notes.txt'), old, old);
    await pruneLogs(root);
    expect(readdirSync(root).sort()).toEqual(['notes.txt', 'servers']);
    expect(readdirSync(join(root, 'servers'))).toEqual(['live.log']);
  });
});

describe('reading', () => {
  const stamp = (offsetMs: number, tag: string, text: string): string => `${new Date(T0 + offsetMs).toISOString()} ${tag.padEnd(6)} ${text}`;

  it('parses a record and a line that is not one', () => {
    expect(parseLine(stamp(0, 'stderr', '  indented'))).toMatchObject({ time: T0, source: 'stderr', text: '  indented' });
    expect(parseLine(stamp(0, 'error', 'boom'))).toMatchObject({ source: 'error', text: 'boom' });
    expect(parseLine('hand written')).toEqual({ time: undefined, source: '', text: 'hand written', raw: 'hand written' });
    expect(parseLine('x\u001b[2Jy').raw).toBe('x\\x1b[2Jy');
  });

  it('parses durations', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('1.5h')).toBe(5_400_000);
    for (const bad of ['', '0s', '10', 'm', '-5m', '5 minutes', '1w']) expect(parseDuration(bad)).toBeUndefined();
  });

  it('reads the last lines across the rotated copies, oldest first', async () => {
    const path = join(tmp(), 'a.log');
    writeFileSync(`${path}.2`, `${stamp(0, 'event', 'a')}\n${stamp(1000, 'event', 'b')}\n`);
    writeFileSync(`${path}.1`, `${stamp(2000, 'event', 'c')}\n`);
    writeFileSync(path, `${stamp(3000, 'event', 'd')}\n${stamp(4000, 'event', 'e')}\n`);
    expect((await readLog(path, { count: 100 })).map((l) => l.text)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect((await readLog(path, { count: 3 })).map((l) => l.text)).toEqual(['c', 'd', 'e']);
    expect(await readLog(path, { count: 0 })).toEqual([]);
    expect((await readLog(path, { count: 100, since: T0 + 2000 })).map((l) => l.text)).toEqual(['c', 'd', 'e']);
    expect((await readLog(path, { count: 1, since: T0 + 2000 })).map((l) => l.text)).toEqual(['e']);
    expect(await readLog(join(tmp(), 'missing.log'), { count: 5 })).toEqual([]);
    expect(rotatedPaths(path)).toHaveLength(LOG_KEEP + 1);
  });

  it('follows new lines, through a rotation, and a file that appears later', async () => {
    const path = join(tmp(), 'a.log');
    const seen: string[] = [];
    const stop = new AbortController();
    const done = followLog(path, { signal: stop.signal, intervalMs: 20, onLines: (lines: LogLine[]) => seen.push(...lines.map((l) => l.text)) });
    const until = async (n: number): Promise<void> => {
      for (let i = 0; i < 200 && seen.length < n; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seen.length).toBeGreaterThanOrEqual(n);
    };
    // the file does not exist yet when the follower first looks
    await new Promise((resolve) => setTimeout(resolve, 60));
    writeFileSync(path, `${stamp(0, 'event', 'one')}\n`);
    await until(1);
    // a line written in two pieces is delivered whole
    const { appendFileSync, renameSync } = await import('node:fs');
    appendFileSync(path, stamp(1, 'event', 'tw'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    appendFileSync(path, 'o\n');
    await until(2);
    // the writer rotates, after one more line the follower has not seen yet
    appendFileSync(path, `${stamp(2, 'event', 'three')}\n`);
    renameSync(path, `${path}.1`);
    writeFileSync(path, `${stamp(3, 'event', 'four')}\n`);
    await until(4);
    stop.abort();
    await done;
    expect(seen).toEqual(['one', 'two', 'three', 'four']);
  });
});
