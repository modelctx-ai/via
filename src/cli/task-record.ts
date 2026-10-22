// via's own record of the tasks it started (cli.md, "任务"; ADR 0020). The 2026-07-28 tasks extension has no
// `tasks/list`, so `via tasks <provider>` can only list what via itself created. The record is a cache:
// one small file per task under `<cache dir>/tasks/<server key>/` (the key of the catalog cache: it binds the
// record to the server definition, not to the alias), mode 0600 in a 0700 directory. It holds the task id, the tool's
// canonical reference, when it was created and the last status seen; never arguments or results. Deleting it only
// loses the listing: `via tasks <provider> <id>` works for any id the server knows.
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerConfig } from '../config/types';
import { sha256Hex } from '../sha256';
import { cacheKey } from './catalog-cache';

/** Per server: at most this many records, none older than {@link MAX_AGE_MS}. */
export const MAX_RECORDS = 50;
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface TaskRecord {
  /** The server's task id, as the server wrote it. */
  id: string;
  /** Canonical reference of the tool that started it (`gh report:generate`). */
  tool: string;
  createdAt: number;
  /** The last status via saw. */
  status?: string;
}

export class TaskRecords {
  constructor(
    /** `<cache dir>/tasks`. */
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private folder(server: ServerConfig): string {
    return join(this.dir, cacheKey(server));
  }

  /** Best effort: a record that cannot be written must never fail a command. */
  put(server: ServerConfig, record: TaskRecord): void {
    try {
      const folder = this.folder(server);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      for (const d of [this.dir, folder]) {
        try {
          chmodSync(d, 0o700);
        } catch {
          // best effort (no-op on Windows)
        }
      }
      const file = join(folder, `${sha256Hex(record.id).slice(0, 24)}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, ...record }), { mode: 0o600 });
      renameSync(tmp, file);
      this.prune(server);
    } catch {
      // see above
    }
  }

  /** Newest first. */
  list(server: ServerConfig): TaskRecord[] {
    const folder = this.folder(server);
    let names: string[];
    try {
      names = readdirSync(folder).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const records: TaskRecord[] = [];
    for (const name of names) {
      try {
        const data = JSON.parse(readFileSync(join(folder, name), 'utf8')) as Partial<TaskRecord> & { version?: unknown };
        if (data.version !== 1 || typeof data.id !== 'string' || typeof data.tool !== 'string' || typeof data.createdAt !== 'number') continue;
        records.push({ id: data.id, tool: data.tool, createdAt: data.createdAt, ...(typeof data.status === 'string' ? { status: data.status } : {}) });
      } catch {
        // an unreadable file is not a record
      }
    }
    return records.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));
  }

  /** The record of one task, if via made it. */
  find(server: ServerConfig, id: string): TaskRecord | undefined {
    return this.list(server).find((r) => r.id === id);
  }

  remove(server: ServerConfig, id: string): void {
    rmSync(join(this.folder(server), `${sha256Hex(id).slice(0, 24)}.json`), { force: true });
  }

  private prune(server: ServerConfig): void {
    const all = this.list(server);
    const cutoff = this.now() - MAX_AGE_MS;
    for (const [i, record] of all.entries()) if (i >= MAX_RECORDS || record.createdAt < cutoff) this.remove(server, record.id);
  }
}
