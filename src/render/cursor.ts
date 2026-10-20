// Cursors: handles for the part of a truncated result that was not shown (output.md, "游标").

import { randomBytes } from 'node:crypto';

/** What a cursor remembers: the full rendered (already redacted) output and how far we got. */
export interface CursorRecord {
  /** Canonical tool reference, for the meta line of continuation pages. */
  ref: string;
  /** Lines repeated at the top of every page (table header); empty for non-table output. */
  header: string[];
  /** Every line of the rendered result, header excluded. */
  lines: string[];
  /** Index of the first line not yet shown. */
  offset: number;
  /** Bytes of rendered output shown so far, including this page. */
  shownBytes: number;
  /** Bytes of the complete rendered output. */
  totalBytes: number;
  /** Page budget in bytes. */
  budget: number;
  /** Table rows hidden by `maxColumns`, kept for the meta line of continuation pages. */
  hiddenColumns: number;
  createdAt: number;
}

/**
 * Where cursors live. 0.1 keeps them in the user cache directory (`FileCursorStore`); the daemon
 * keeps them in memory. Ids are opaque: random, never derived from credentials or arguments.
 */
export interface CursorStore {
  put(record: CursorRecord): Promise<string>;
  /** Undefined when the id is unknown or expired. */
  get(id: string): Promise<CursorRecord | undefined>;
}

/** Cursors are kept for 30 minutes. */
export const CURSOR_TTL_MS = 30 * 60 * 1000;

export const CURSOR_ID_PATTERN = /^[0-9a-f]{4,16}$/;

export interface StoreOptions {
  ttlMs?: number;
  now?: () => number;
  /** Id generator; tests inject a deterministic one. `length` grows after collisions. */
  generateId?: (length: number) => string;
}

export function randomCursorId(length: number): string {
  return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

/** Pick an unused id: 4 hex digits (`c7f2`), growing when the namespace is crowded. */
export async function allocateId(
  exists: (id: string) => Promise<boolean> | boolean,
  generate: (length: number) => string,
): Promise<string> {
  for (let length = 4; length <= 16; length += 2) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = generate(length);
      if (!(await exists(id))) return id;
    }
  }
  throw new Error('could not allocate a cursor id');
}

export class MemoryCursorStore implements CursorStore {
  private readonly records = new Map<string, CursorRecord>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly generate: (length: number) => string;

  constructor(options: StoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? CURSOR_TTL_MS;
    this.now = options.now ?? Date.now;
    this.generate = options.generateId ?? randomCursorId;
  }

  /** Cursors held right now (expired ones are only dropped on the next `put`). */
  get size(): number {
    return this.records.size;
  }

  async put(record: CursorRecord): Promise<string> {
    this.sweep();
    const id = await allocateId((candidate) => this.records.has(candidate), this.generate);
    this.records.set(id, record);
    return id;
  }

  async get(id: string): Promise<CursorRecord | undefined> {
    const record = this.records.get(id);
    if (!record) return undefined;
    if (this.now() - record.createdAt > this.ttlMs) {
      this.records.delete(id);
      return undefined;
    }
    return record;
  }

  private sweep(): void {
    for (const [id, record] of this.records) {
      if (this.now() - record.createdAt > this.ttlMs) this.records.delete(id);
    }
  }
}

// Pagination ---------------------------------------------------------------

const byteLength = (s: string) => Buffer.byteLength(s, 'utf8');

/** Bytes a list of lines occupies once written with newlines. */
export function linesBytes(lines: readonly string[]): number {
  return lines.reduce((n, l) => n + byteLength(l) + 1, 0);
}

/** Cut lines longer than `maxBytes` so every line can fit on a page. Splits on code points. */
export function splitLongLines(lines: readonly string[], maxBytes: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (byteLength(line) <= maxBytes) {
      out.push(line);
      continue;
    }
    let chunk = '';
    for (const ch of line) {
      if (byteLength(chunk) + byteLength(ch) > maxBytes) {
        out.push(chunk);
        chunk = '';
      }
      chunk += ch;
    }
    if (chunk) out.push(chunk);
  }
  return out;
}

export interface Page {
  /** Header followed by the lines that fit. */
  lines: string[];
  /** Index of the first line left over; equals `lines.length` of the source when finished. */
  next: number;
  /** Bytes of the lines taken from the body (header excluded). */
  bodyBytes: number;
}

/**
 * Take lines starting at `start` while the page, header included, stays within `budget` bytes.
 * Always takes at least one line so paging makes progress.
 */
export function takePage(header: readonly string[], lines: readonly string[], start: number, budget: number): Page {
  let used = linesBytes(header);
  let bodyBytes = 0;
  let next = start;
  while (next < lines.length) {
    const size = byteLength(lines[next]!) + 1;
    if (next > start && used + size > budget) break;
    used += size;
    bodyBytes += size;
    next += 1;
  }
  return { lines: [...header, ...lines.slice(start, next)], next, bodyBytes };
}
