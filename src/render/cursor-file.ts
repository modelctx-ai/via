import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  allocateId,
  CURSOR_ID_PATTERN,
  CURSOR_TTL_MS,
  randomCursorId,
  type CursorRecord,
  type CursorStore,
  type StoreOptions,
} from './cursor';

/**
 * Cursor store for in-process mode: one JSON file per cursor in a private (0700) cache
 * directory, removed after the TTL (output.md, "游标"). The files hold already-redacted output.
 */
export class FileCursorStore implements CursorStore {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly generate: (length: number) => string;

  constructor(
    private readonly dir: string,
    options: StoreOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? CURSOR_TTL_MS;
    this.now = options.now ?? Date.now;
    this.generate = options.generateId ?? randomCursorId;
  }

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700).catch(() => undefined); // best effort (no-op on Windows)
  }

  async put(record: CursorRecord): Promise<string> {
    await this.ensureDir();
    await this.sweep();
    const id = await allocateId(
      (candidate) => stat(this.file(candidate)).then(() => true, () => false),
      this.generate,
    );
    await writeFile(this.file(id), JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    return id;
  }

  async get(id: string): Promise<CursorRecord | undefined> {
    if (!CURSOR_ID_PATTERN.test(id)) return undefined; // never build a path from arbitrary input
    let record: CursorRecord;
    try {
      record = JSON.parse(await readFile(this.file(id), 'utf8')) as CursorRecord;
    } catch {
      return undefined;
    }
    if (this.now() - record.createdAt > this.ttlMs) {
      await rm(this.file(id), { force: true });
      return undefined;
    }
    return record;
  }

  /** Cursors on disk that have not expired yet. */
  async count(): Promise<number> {
    const cutoff = this.now() - this.ttlMs;
    let n = 0;
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue;
      const info = await stat(join(this.dir, name)).catch(() => undefined);
      if (info && info.mtimeMs >= cutoff) n += 1;
    }
    return n;
  }

  /** Delete expired cursors. */
  private async sweep(): Promise<void> {
    const cutoff = this.now() - this.ttlMs;
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.dir, name);
      const info = await stat(path).catch(() => undefined);
      if (info && info.mtimeMs < cutoff) await rm(path, { force: true });
    }
  }
}
