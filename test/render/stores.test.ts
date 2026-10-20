import { mkdtempSync, rmSync, statSync, readdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CURSOR_TTL_MS,
  FileCursorStore,
  FileMediaSink,
  MemoryCursorStore,
  renderMore,
  renderOptions,
  renderToolResult,
  type CursorRecord,
} from '../../src/render';
import { PNG_1X1_BASE64, manyRows } from '../fixtures/results';
import { makeContext, sequentialIds, structured } from '../helpers/render';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'via-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const record = (createdAt = Date.now()): CursorRecord => ({
  ref: 'a b:c',
  header: ['h'],
  lines: ['one', 'two'],
  offset: 1,
  shownBytes: 6,
  totalBytes: 14,
  budget: 100,
  hiddenColumns: 0,
  createdAt,
});

const isPosix = process.platform !== 'win32';

describe('FileCursorStore (0.1 keeps cursors in the user cache directory)', () => {
  it('round-trips a cursor in a private directory', async () => {
    const root = join(dir, 'cache', 'cursors');
    const store = new FileCursorStore(root, { generateId: sequentialIds(), now: () => 1_000 });
    const stored = record(1_000);
    const id = await store.put(stored);
    expect(id).toMatch(/^[0-9a-f]{4}$/);
    expect(await store.get(id)).toEqual(stored);
    if (isPosix) {
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, `${id}.json`)).mode & 0o777).toBe(0o600);
    }
  });

  it('drops cursors after the TTL', async () => {
    let now = 1_000;
    const store = new FileCursorStore(join(dir, 'c'), { now: () => now });
    const id = await store.put(record(now));
    now += CURSOR_TTL_MS + 1;
    expect(await store.get(id)).toBeUndefined();
    expect(readdirSync(join(dir, 'c'))).toEqual([]);
  });

  it('sweeps expired files when storing a new cursor', async () => {
    const root = join(dir, 'c');
    const store = new FileCursorStore(root, { now: () => Date.now() });
    await store.put(record(Date.now()));
    const stale = join(root, 'dead.json');
    writeFileSync(stale, '{}');
    const old = new Date(Date.now() - CURSOR_TTL_MS - 60_000);
    utimesSync(stale, old, old);
    await store.put(record(Date.now()));
    expect(readdirSync(root)).not.toContain('dead.json');
  });

  it('never builds a path from an arbitrary id', async () => {
    const store = new FileCursorStore(join(dir, 'c'));
    writeFileSync(join(dir, 'secret.json'), JSON.stringify(record()));
    for (const id of ['../secret', '..%2fsecret', '', 'ABCD', 'xyz1', 'a'.repeat(40)]) {
      expect(await store.get(id)).toBeUndefined();
    }
  });

  it('allocates distinct ids and grows the id length after collisions', async () => {
    const store = new MemoryCursorStore({ generateId: (n) => 'abcdef0123456789'.slice(0, n) });
    const a = await store.put(record());
    const b = await store.put(record());
    expect(a).toBe('abcd');
    expect(b).toBe('abcdef');
  });

  it('works end to end behind the CursorStore interface', async () => {
    const store = new FileCursorStore(join(dir, 'c'));
    const ctx = makeContext({ cursors: store });
    const first = await renderToolResult(structured(manyRows), renderOptions({ budget: 600 }), ctx);
    const id = /via more ([0-9a-f]+)/.exec(first.stderr)![1]!;
    const second = await renderMore(id, ctx);
    expect(second.exitCode).toBe(0);
    expect(second.stdout.split('\n')[0]).toBe(first.stdout.split('\n')[0]);
  });
});

describe('FileMediaSink', () => {
  it('writes decoded media into a private directory and returns the path', () => {
    const sink = new FileMediaSink(join(dir, 'media'));
    const path = sink.save({ data: PNG_1X1_BASE64, mimeType: 'image/png' });
    expect(path.startsWith(join(dir, 'media'))).toBe(true);
    expect(path).toMatch(/\.png$/);
    expect(statSync(path).size).toBe(Buffer.from(PNG_1X1_BASE64, 'base64').length);
    if (isPosix) expect(statSync(join(dir, 'media')).mode & 0o777).toBe(0o700);
    expect(sink.save({ data: PNG_1X1_BASE64, mimeType: 'image/png' })).toBe(path); // content-addressed
  });

  it('picks an extension from the MIME type', () => {
    const sink = new FileMediaSink(join(dir, 'media'));
    expect(sink.save({ data: 'AAAA', mimeType: 'audio/wav' })).toMatch(/\.wav$/);
    expect(sink.save({ data: 'AAAA', mimeType: 'application/x-foo' })).toMatch(/\.foo$/);
    expect(sink.save({ data: 'BBBB', mimeType: '???' })).toMatch(/\.bin$/);
  });
});
