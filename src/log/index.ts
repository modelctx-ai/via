// Logs of the daemon and of each server (daemon.md "日志", ADR 0022): plain text lines in the user cache
// directory, rotated by size, redacted before they are written, and written without ever making the call
// that caused them wait. Everything here is best effort: a log that cannot be written is dropped silently,
// since losing a line is better than failing a tool call.
import { appendFileSync, mkdirSync } from 'node:fs';
import { appendFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { sha256Hex } from '../sha256';
import type { Redactor } from '../render/redact';

/** A log file is rotated when it would grow beyond this. */
export const LOG_MAX_BYTES = 1024 * 1024;
/** Rotated copies kept next to the live file (`.1` newest): at most `(KEEP + 1) * MAX_BYTES` per log. */
export const LOG_KEEP = 3;
/** The daemon removes logs nobody wrote to for this long when it starts. */
export const LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** Longest line kept; the rest of a longer line is cut off (after redaction). */
export const LOG_MAX_LINE = 4096;
/** A server line without a line break is cut at this length: the buffer behind it must stay small. */
const PENDING_MAX = 16 * 1024;
/** What is dropped from the end of a line that had to be cut before it was complete: a credential may start there. */
const PENDING_HOLD_BACK = 4096;
/** Lines wait this long for company before they are written. */
const FLUSH_MS = 100;
/** Pending text beyond this is written without waiting. */
const FLUSH_BYTES = 32 * 1024;

/** Where logs live: `logs/` in the user cache directory (same permissions as the rest of it). */
export const logDir = (cacheDir: string): string => join(cacheDir, 'logs');

export const daemonLogPath = (dir: string): string => join(dir, 'daemon.log');

/**
 * The log of server `name` (the key under `servers`). A name that is not made of safe characters is
 * reduced to them and given a short digest so two different names never share a file.
 */
export function serverLogPath(dir: string, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 48);
  const plain = safe === name && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(safe) && safe !== '';
  const stem = plain ? safe : `${safe === '' ? 'server' : safe}~${sha256Hex(name).slice(0, 8)}`;
  return join(dir, 'servers', `${stem}.log`);
}

/** `path` and its rotated copies, oldest first (whichever exist is up to the reader). */
export function rotatedPaths(path: string): string[] {
  return [...Array.from({ length: LOG_KEEP }, (_, i) => `${path}.${LOG_KEEP - i}`), path];
}

/** Control characters, escape sequences' ESC, bidi and zero-width characters become visible escapes; tab stays. */
export function plain(text: string): string {
  return text.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, (c) => {
    const code = c.charCodeAt(0);
    return code < 0x100 ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

// File -----------------------------------------------------------------------------------------

export interface LogFileOptions {
  maxBytes?: number;
  keep?: number;
  now?: () => number;
}

/**
 * One log file. `append` only queues a line (no file access on the caller's path); the queue is written
 * about 100 ms later by one asynchronous writer, which also rotates. Several processes (the daemon and
 * an in-process CLI) may append to the same file: each write is a single `O_APPEND` write of whole lines.
 */
export class LogFile {
  private queue: string[] = [];
  private queued = 0;
  private timer?: NodeJS.Timeout;
  private chain: Promise<void> = Promise.resolve();
  private ready = false;
  private broken = false;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly now: () => number;

  constructor(
    readonly path: string,
    options: LogFileOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
    this.keep = options.keep ?? LOG_KEEP;
    this.now = options.now ?? Date.now;
  }

  /** Queue one record: `<time> <tag> <text>`. `text` has been made safe by the caller (one line, redacted). */
  append(tag: string, text: string): void {
    if (this.broken) return;
    const line = `${new Date(this.now()).toISOString()} ${tag.padEnd(6)} ${text}\n`;
    this.queue.push(line);
    this.queued += line.length;
    if (this.queued >= FLUSH_BYTES) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_MS);
      this.timer.unref();
    }
  }

  /** Write what is queued; resolves when it is on its way to the disk. Never rejects. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.queue.length === 0) return this.chain;
    const text = this.queue.join('');
    this.queue = [];
    this.queued = 0;
    this.chain = this.chain.then(() => this.write(text)).catch(() => undefined);
    return this.chain;
  }

  /** Write what is queued right now (the process is about to exit). */
  flushSync(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.queue.length === 0) return;
    const text = this.queue.join('');
    this.queue = [];
    this.queued = 0;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.path, text, { mode: 0o600 });
    } catch {
      // dropped
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }

  /**
   * Append `text`, rotating first when it would not fit. The file is looked at (and opened) afresh each time
   * instead of being held open: another process may have rotated it since, and a few writes a second are cheap.
   */
  private async write(text: string): Promise<void> {
    try {
      const bytes = Buffer.byteLength(text);
      if (!this.ready) {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        this.ready = true;
      }
      const size = await stat(this.path).then((s) => s.size, () => 0);
      if (size > 0 && size + bytes > this.maxBytes) await this.rotate();
      await appendFile(this.path, text, { mode: 0o600 });
    } catch {
      // A log that cannot be written (read-only cache, disk full) is given up on for this process.
      this.broken = true;
    }
  }

  /** `log` → `log.1` → … → `log.<keep>`; the oldest goes. Where a file in use cannot be renamed (Windows), the live one is emptied instead. */
  private async rotate(): Promise<void> {
    try {
      for (let i = this.keep; i >= 1; i -= 1) {
        const from = i === 1 ? this.path : `${this.path}.${i - 1}`;
        await rename(from, `${this.path}.${i}`).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    } catch {
      await unlink(this.path).catch(() => undefined);
    }
  }
}

const registry = new Map<string, LogFile>();

/** The one `LogFile` of `path` in this process (sessions of the same server share a file). */
export function openLog(path: string, options?: LogFileOptions): LogFile {
  let file = registry.get(path);
  if (!file) {
    file = new LogFile(path, options);
    registry.set(path, file);
  }
  return file;
}

/** Forget every open log of this process (tests that remove their directory). */
export async function closeLogs(): Promise<void> {
  const files = [...registry.values()];
  registry.clear();
  await Promise.all(files.map((f) => f.close()));
}

/** Delete logs nobody wrote to for `LOG_RETENTION_MS` (the servers they belonged to are gone). Best effort. */
export async function pruneLogs(dir: string, now: number = Date.now()): Promise<void> {
  for (const sub of [dir, join(dir, 'servers')]) {
    let names: string[];
    try {
      names = await readdir(sub);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/\.log(\.\d+)?$/.test(name)) continue;
      const file = join(sub, name);
      try {
        if (now - (await stat(file)).mtimeMs > LOG_RETENTION_MS) await unlink(file);
      } catch {
        // gone, or not ours to remove
      }
    }
  }
}

/** How much the logs in `dir` take: `undefined` when the directory does not exist (nothing was logged yet). */
export async function logsSummary(dir: string): Promise<{ files: number; bytes: number } | undefined> {
  try {
    await stat(dir);
  } catch {
    return undefined;
  }
  let files = 0;
  let bytes = 0;
  for (const sub of [dir, join(dir, 'servers')]) {
    let names: string[];
    try {
      names = await readdir(sub);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/\.log(\.\d+)?$/.test(name)) continue;
      try {
        const info = await stat(join(sub, name));
        if (!info.isFile()) continue;
        files += 1;
        bytes += info.size;
      } catch {
        // removed while counting
      }
    }
  }
  return { files, bytes };
}

// What the daemon and the sessions write ---------------------------------------------------------

/**
 * A log with redaction: `event` lines are text via composed (credentials of 8 characters or more are
 * looked for, output.md "脱敏"); `stderr` is a stdio child's own output, which is content, so every
 * known credential is replaced whatever its length. A line is redacted whole before it is cut, and
 * a line that is still incomplete when it has to be cut loses its end, where a credential may begin.
 */
export class ServerLog {
  private pending = '';
  private skipping = false;

  constructor(
    private readonly file: LogFile,
    private readonly redact: Redactor,
  ) {}

  get path(): string {
    return this.file.path;
  }

  event(text: string): void {
    this.record('event', this.redact.scan(text));
  }

  error(text: string): void {
    this.record('error', this.redact.scan(text));
  }

  /** A piece of a child's stderr; lines are written once complete. */
  stderr(chunk: string): void {
    let rest = this.pending + chunk;
    this.pending = '';
    for (;;) {
      const at = rest.search(/\r\n|\n|\r/);
      if (at < 0) break;
      const line = rest.slice(0, at);
      rest = rest.slice(rest[at] === '\r' && rest[at + 1] === '\n' ? at + 2 : at + 1);
      if (this.skipping) this.skipping = false;
      else this.line(line);
    }
    if (this.skipping) return;
    if (rest.length > PENDING_MAX) {
      // No end of line in sight: write what is safely before the end and ignore the rest of this line.
      const kept = this.redact(rest);
      this.record('stderr', kept.length > PENDING_HOLD_BACK ? `${kept.slice(0, kept.length - PENDING_HOLD_BACK)}…` : '…');
      this.skipping = true;
      return;
    }
    this.pending = rest;
  }

  /** Write the unfinished line and everything queued. */
  async flush(): Promise<void> {
    if (this.pending !== '') this.line(this.pending);
    this.pending = '';
    this.skipping = false;
    await this.file.flush();
  }

  private line(raw: string): void {
    if (raw.trim() === '') return;
    this.record('stderr', this.redact(raw));
  }

  private record(tag: string, text: string): void {
    const safe = plain(text);
    this.file.append(tag, safe.length > LOG_MAX_LINE ? `${safe.slice(0, LOG_MAX_LINE)}… (${safe.length - LOG_MAX_LINE} more characters)` : safe);
  }
}

/** The scheme and host of a URL, nothing else: the path and query may carry credentials (output.md "错误"). */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'an invalid URL';
  }
}

/** The program name of a command, without directories or arguments (arguments may hold secrets). */
export function programOf(command: string): string {
  return basename(command.replace(/\\/g, '/'));
}
