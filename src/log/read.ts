// Reading logs back (`via daemon logs`, daemon.md "日志"): the last lines across a log and its rotated
// copies, optionally since a time, and following the live file through rotations. Reads text the writer
// already made safe; control characters are escaped again anyway, since a file is only a file.
import { readFile, open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { plain, rotatedPaths } from './index';

/** One log line: `2026-10-21T16:12:03.123Z event  connected …`. */
export interface LogLine {
  /** Milliseconds since the epoch; undefined for a line that does not start with a time. */
  time: number | undefined;
  source: string;
  text: string;
  raw: string;
}

/** A record is `<24-character time> <tag padded to 6> <text>` (LogFile.append). */
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /;

export function parseLine(raw: string): LogLine {
  const clean = plain(raw);
  if (!STAMP.test(clean)) return { time: undefined, source: '', text: clean, raw: clean };
  return { time: Date.parse(clean.slice(0, 24)), source: clean.slice(25, 31).trim(), text: clean.slice(32), raw: clean };
}

/**
 * `30s`, `10m`, `2h`, `1d` as milliseconds (several in a row add up: `1h30m`); undefined for anything else,
 * zero included.
 */
export function parseDuration(text: string): number | undefined {
  const parts = /^(?:\d+(?:\.\d+)?[smhd])+$/.exec(text.trim()) ? [...text.trim().matchAll(/(\d+(?:\.\d+)?)([smhd])/g)] : [];
  if (parts.length === 0) return undefined;
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  const total = parts.reduce((sum, [, n, u]) => sum + Number(n) * unit[u as keyof typeof unit], 0);
  return total > 0 ? Math.round(total) : undefined;
}

/**
 * The last `count` lines of the log at `path` (all of it with `Infinity`), rotated copies included, oldest
 * first. With `since`, only lines from that time on; a line without a time belongs to the one before it.
 */
export async function readLog(path: string, options: { count: number; since?: number }): Promise<LogLine[]> {
  const lines: LogLine[] = [];
  for (const file of rotatedPaths(path)) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const raw of text.split('\n')) if (raw !== '') lines.push(parseLine(raw));
  }
  let kept = lines;
  if (options.since !== undefined) {
    let keep = false;
    kept = lines.filter((l) => {
      if (l.time !== undefined) keep = l.time >= options.since!;
      return keep;
    });
  }
  return options.count >= kept.length ? kept : options.count <= 0 ? [] : kept.slice(-options.count);
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

async function statOf(path: string): Promise<{ ino: number; size: number } | undefined> {
  try {
    const s = await stat(path);
    return { ino: s.ino, size: s.size };
  } catch {
    return undefined;
  }
}

/**
 * Call `onLines` with the lines appended to the log at `path` from now on, until `signal` aborts. A rotation
 * (the file was renamed to `.1` and a new one started) is followed: what the old file still got is read from
 * `.1`, then the new file from its start. A file that did not exist yet is waited for. Polls: a watcher would
 * need a native module on some platforms and notices rotations badly everywhere.
 */
export async function followLog(path: string, options: { signal: AbortSignal; onLines: (lines: LogLine[]) => void; intervalMs?: number }): Promise<void> {
  const { signal } = options;
  const first = await statOf(path);
  let ino = first?.ino;
  let offset = first?.size ?? 0;
  let decoder = new StringDecoder('utf8');
  let carry = '';

  const emit = (text: string): void => {
    carry += text;
    const parts = carry.split('\n');
    carry = parts.pop() ?? '';
    const lines = parts.filter((p) => p !== '').map(parseLine);
    if (lines.length > 0) options.onLines(lines);
  };
  const readFrom = async (file: string, from: number, to: number): Promise<void> => {
    if (to <= from) return;
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(to - from);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
      emit(decoder.write(buffer.subarray(0, bytesRead)));
    } finally {
      await handle.close();
    }
  };

  while (!signal.aborted) {
    await sleep(options.intervalMs ?? 250, signal);
    if (signal.aborted) return;
    try {
      const now = await statOf(path);
      if (!now) continue;
      if (ino === undefined) {
        ino = now.ino;
        offset = 0;
      } else if (now.ino !== ino) {
        // Rotated: the old file went on as `.1`, with whatever it was given after we last looked.
        const old = await statOf(`${path}.1`);
        if (old && old.ino === ino) await readFrom(`${path}.1`, offset, old.size);
        ino = now.ino;
        offset = 0;
        carry = '';
        decoder = new StringDecoder('utf8');
      } else if (now.size < offset) {
        offset = 0;
        carry = '';
        decoder = new StringDecoder('utf8');
      }
      if (now.size > offset) {
        await readFrom(path, offset, now.size);
        offset = now.size;
      }
    } catch {
      // The file is being rotated under us; the next round looks again.
    }
  }
}
