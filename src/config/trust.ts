// Trust records for project-scoped configuration (security.md, "项目级配置的信任").
//
// A stdio command that comes from a file inside a project may belong to an untrusted repository,
// so it only runs after the person confirmed that exact file content. A record is the file path
// plus the SHA-256 of its content, kept in the user data directory; a changed file is untrusted again.
// The `via trust` command (src/cli/commands/trust.ts) is built on `recordTrustHash`; this module has no CLI.

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface TrustRecord {
  /** Hex SHA-256 of the file content that was confirmed. */
  sha256: string;
  /** ISO timestamp of the confirmation. */
  trustedAt: string;
}

export interface TrustStore {
  version: 1;
  /** Keyed by `trustKey(path)`. */
  entries: Record<string, TrustRecord>;
}

export type TrustStatus = 'trusted' | 'untrusted' | 'changed';

export function trustStorePath(dataDir: string): string {
  return join(dataDir, 'trust.json');
}

export function hashContent(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** The key a file is recorded under: its real path, so a symlink cannot borrow another file's trust. */
export function trustKey(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function emptyStore(): TrustStore {
  return { version: 1, entries: {} };
}

function isRecord(value: unknown): value is TrustRecord {
  return typeof value === 'object' && value !== null && typeof (value as TrustRecord).sha256 === 'string' && typeof (value as TrustRecord).trustedAt === 'string';
}

/**
 * Read the store. A missing file is an empty store; an unreadable or corrupt one is also empty
 * (nothing is trusted) and reported in `error`.
 */
export function readTrustStore(dataDir: string): { store: TrustStore; error?: string } {
  let text: string;
  try {
    text = readFileSync(trustStorePath(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { store: emptyStore() };
    return { store: emptyStore(), error: `cannot read ${trustStorePath(dataDir)}: ${(error as NodeJS.ErrnoException).code ?? 'read error'}` };
  }
  try {
    const parsed = JSON.parse(text) as { version?: unknown; entries?: unknown };
    if (parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) throw new Error('unexpected format');
    const store = emptyStore();
    for (const [key, record] of Object.entries(parsed.entries)) {
      if (key !== '__proto__' && isRecord(record)) store.entries[key] = { sha256: record.sha256, trustedAt: record.trustedAt };
    }
    return { store };
  } catch {
    return { store: emptyStore(), error: `${trustStorePath(dataDir)} is not a valid trust store; nothing is trusted until it is fixed or removed` };
  }
}

export function trustStatus(store: TrustStore, path: string, sha256: string): TrustStatus {
  const record = Object.prototype.hasOwnProperty.call(store.entries, trustKey(path)) ? store.entries[trustKey(path)] : undefined;
  if (!record) return 'untrusted';
  return record.sha256 === sha256 ? 'trusted' : 'changed';
}

export function isTrusted(store: TrustStore, path: string, sha256: string): boolean {
  return trustStatus(store, path, sha256) === 'trusted';
}

/** Check a file against the store on disk, hashing the content as it is now. */
export function checkTrust(dataDir: string, path: string): TrustStatus {
  let content: Buffer;
  try {
    content = readFileSync(path);
  } catch {
    return 'untrusted';
  }
  return trustStatus(readTrustStore(dataDir).store, path, hashContent(content));
}

/**
 * Record the current content of `path` as trusted. `content` is the exact bytes the caller showed
 * the person; pass it to avoid trusting something that changed in between. Directory mode is 0700
 * and file mode 0600; the file is replaced atomically.
 */
export function recordTrust(dataDir: string, path: string, content?: string | Uint8Array, now: () => Date = () => new Date()): TrustRecord {
  return recordTrustHash(dataDir, path, hashContent(content ?? readFileSync(path)), now);
}

/**
 * Record a hash directly: the one `loadConfig` computed over the bytes it parsed (`LoadedFile.sha256`).
 * `via trust` uses this, so what gets trusted is what was shown, even if the file changed since.
 */
export function recordTrustHash(dataDir: string, path: string, sha256: string, now: () => Date = () => new Date()): TrustRecord {
  const record: TrustRecord = { sha256, trustedAt: now().toISOString() };
  const { store, error } = readTrustStore(dataDir);
  if (error?.includes('not a valid trust store')) {
    // Start over rather than keep entries that cannot be read; nothing was trusted by them anyway.
    store.entries = {};
  }
  store.entries[trustKey(path)] = record;
  writeStore(dataDir, store);
  return record;
}

/** Remove the record of a file. Returns whether there was one. */
export function forgetTrust(dataDir: string, path: string): boolean {
  const { store } = readTrustStore(dataDir);
  const key = trustKey(path);
  if (!Object.prototype.hasOwnProperty.call(store.entries, key)) return false;
  delete store.entries[key];
  writeStore(dataDir, store);
  return true;
}

function writeStore(dataDir: string, store: TrustStore): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dataDir, 0o700);
  } catch {
    // Not supported on every platform or file system; the file mode below still applies.
  }
  const file = trustStorePath(dataDir);
  const tmp = join(dirname(file), `.trust.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, flag: 'w' });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
