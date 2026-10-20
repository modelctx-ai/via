// Where OAuth logins are kept (auth.md, "存储"). One record per server definition: tokens, the
// registered client and the discovery cache, as one JSON document. The system keychain is the
// preferred home (service `via`, account `oauth:<hash>`); where it does not work, a 0600 file in
// the user data directory takes over. Nothing here prints or logs a record.
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { pathContext, userDataDir, type Env, type PathContext } from '../../config/paths';

export const KEYCHAIN_SERVICE = 'via';

/**
 * Windows Credential Manager keeps at most 2560 bytes (1280 UTF-16 characters) per credential, and a
 * record with tokens, client registration and discovery results is often longer. On Windows a
 * longer record is split over several entries (`<account>#0`, `#1`, …) and the main entry holds
 * this marker and the number of pieces. The marker is not JSON, so nothing mistakes it for a record.
 */
const CHUNK_MARKER = 'via:chunks:';
const CHUNK_SIZE = 1000;
const MAX_CHUNKS = 32;

/** Cut `text` into pieces of at most `size` characters, never between the halves of a surrogate pair. */
export function splitForKeychain(text: string, size = CHUNK_SIZE): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

export interface OAuthRecord {
  version: 1;
  /** The MCP endpoint this login is for. */
  serverUrl: string;
  /** The client registered with the authorization server (dynamic registration), if any. */
  clientInformation?: OAuthClientInformationMixed;
  /** Absent once a refresh was rejected: the login is gone, the client registration stays. */
  tokens?: OAuthTokens;
  /** Epoch milliseconds when `tokens` were issued. */
  obtainedAt?: number;
  /** Epoch milliseconds when the access token expires; absent when the server gave no `expires_in`. */
  expiresAt?: number;
  /** The scope the server granted (or that was requested, when it did not say). */
  scope?: string;
  /** Discovery results, so a refresh does not have to rediscover. */
  discovery?: OAuthDiscoveryState;
}

export interface OAuthLocation {
  kind: 'keychain' | 'file';
  /** Absolute path for `file`. */
  path?: string;
}

export interface StoredLogin {
  record: OAuthRecord;
  location: OAuthLocation;
}

export interface SetResult {
  location: OAuthLocation;
  /** Why the file was used instead of the keychain, when it was. */
  fallbackReason?: string;
}

export interface OAuthStore {
  get(key: string): Promise<StoredLogin | undefined>;
  set(key: string, record: OAuthRecord): Promise<SetResult>;
  /** Remove the record everywhere; returns whether there was one. */
  delete(key: string): Promise<boolean>;
}

/** What the store needs from a server definition. */
export interface OAuthIdentity {
  url: string;
  clientId?: string;
  scopes?: readonly string[];
}

/**
 * Storage key of a server: a hash of the definition that decides which login is valid (endpoint,
 * client id, scopes). Two names for the same definition share one login; changing any of the three
 * means logging in again.
 */
export function oauthKey(identity: OAuthIdentity): string {
  let url = identity.url;
  try {
    url = new URL(identity.url).href;
  } catch {
    // keep the text as written
  }
  const material = JSON.stringify([url, identity.clientId ?? null, [...(identity.scopes ?? [])].sort()]);
  return `oauth:${createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}

/** Values of a record that must never appear in output. */
export function secretsOf(record: OAuthRecord): string[] {
  const out: string[] = [];
  const t = record.tokens;
  if (t) out.push(t.access_token, ...(t.refresh_token ? [t.refresh_token] : []), ...(t.id_token ? [t.id_token] : []));
  const secret = (record.clientInformation as { client_secret?: string } | undefined)?.client_secret;
  if (secret) out.push(secret);
  return out;
}

// Record (de)serialization ---------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse stored text; a corrupt or foreign document counts as "no login". */
export function parseRecord(text: string): OAuthRecord | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isObject(raw) || raw.version !== 1 || typeof raw.serverUrl !== 'string') return undefined;
    const tokens = raw.tokens;
    if (tokens !== undefined && !(isObject(tokens) && typeof tokens.access_token === 'string')) return undefined;
    return raw as unknown as OAuthRecord;
  } catch {
    return undefined;
  }
}

// Stores ---------------------------------------------------------------------------------------

/** The slice of `@napi-rs/keyring` used here. */
export interface OAuthKeyring {
  AsyncEntry: new (
    service: string,
    account: string,
  ) => {
    getPassword(): Promise<string | null>;
    setPassword(password: string): Promise<void>;
    deletePassword(): Promise<boolean>;
  };
}

export type StoreMode = 'auto' | 'file' | 'keychain';

export interface OAuthStoreOptions {
  home?: string;
  env?: Env;
  platform?: NodeJS.Platform;
  /** Overrides `VIA_OAUTH_STORE`. */
  mode?: StoreMode;
  /** Directory of the fallback files. Default: `<user data dir>/oauth`. */
  dir?: string;
  /** Loader for the keychain module; the default imports `@napi-rs/keyring` on first use. */
  loadKeyring?: () => Promise<OAuthKeyring>;
}

export function storeModeFromEnv(env: Env): StoreMode {
  const value = env.VIA_OAUTH_STORE;
  return value === 'file' || value === 'keychain' ? value : 'auto';
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? 'unknown error';
}

export function createOAuthStore(options: OAuthStoreOptions = {}): OAuthStore {
  const ctx: PathContext = pathContext(options);
  const mode = options.mode ?? storeModeFromEnv(ctx.env);
  const dir = options.dir ?? join(userDataDir(ctx), 'oauth');
  const loadKeyring = options.loadKeyring ?? (async () => (await import('@napi-rs/keyring')) as unknown as OAuthKeyring);

  const filePath = (key: string): string => join(dir, `${key.replace(/[^A-Za-z0-9._-]/g, '-')}.json`);

  async function readFileRecord(key: string): Promise<OAuthRecord | undefined> {
    try {
      return parseRecord(await readFile(filePath(key), 'utf8'));
    } catch {
      return undefined;
    }
  }

  async function writeFileRecord(key: string, record: OAuthRecord): Promise<string> {
    const file = filePath(key);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => undefined);
    const tmp = join(dirname(file), `.${process.pid}.${Date.now()}.tmp`);
    try {
      await writeFile(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'w' });
      await chmod(tmp, 0o600).catch(() => undefined);
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
    return file;
  }

  async function entry(key: string) {
    const { AsyncEntry } = await loadKeyring();
    return new AsyncEntry(KEYCHAIN_SERVICE, key);
  }

  const chunked = ctx.platform === 'win32';

  /** The stored text of `key`, reassembled when it was split; null when absent or incomplete. */
  async function keychainRead(key: string): Promise<string | null> {
    const main = await (await entry(key)).getPassword();
    if (main === null || !main.startsWith(CHUNK_MARKER)) return main;
    const count = Number(main.slice(CHUNK_MARKER.length));
    if (!Number.isInteger(count) || count < 1 || count > MAX_CHUNKS) return null;
    let text = '';
    for (let i = 0; i < count; i += 1) {
      const piece = await (await entry(`${key}#${i}`)).getPassword();
      if (piece === null) return null;
      text += piece;
    }
    return text;
  }

  /** Remove the pieces `#from`, `#from+1`, … until there is none. */
  async function dropPieces(key: string, from: number): Promise<void> {
    for (let i = from; i < MAX_CHUNKS; i += 1) {
      const piece = await entry(`${key}#${i}`);
      if ((await piece.getPassword()) === null) return;
      await piece.deletePassword();
    }
  }

  async function keychainWrite(key: string, text: string): Promise<void> {
    if (!chunked) {
      await (await entry(key)).setPassword(text);
      return;
    }
    const pieces = text.length <= CHUNK_SIZE ? [] : splitForKeychain(text);
    if (pieces.length > MAX_CHUNKS) throw new Error('the login record is too large for the keychain');
    // Pieces first, then the entry that points at them: a reader never sees a marker without its pieces.
    for (const [i, piece] of pieces.entries()) await (await entry(`${key}#${i}`)).setPassword(piece);
    await (await entry(key)).setPassword(pieces.length === 0 ? text : `${CHUNK_MARKER}${pieces.length}`);
    await dropPieces(key, pieces.length);
  }

  async function keychainDelete(key: string): Promise<boolean> {
    const e = await entry(key);
    const present = (await e.getPassword()) !== null;
    if (present) await e.deletePassword();
    if (chunked) await dropPieces(key, 0);
    return present;
  }

  return {
    async get(key) {
      if (mode !== 'file') {
        try {
          const text = await keychainRead(key);
          const record = text ? parseRecord(text) : undefined;
          if (record) return { record, location: { kind: 'keychain' } };
        } catch (error) {
          if (mode === 'keychain') throw new Error(`cannot read the system keychain: ${firstLine(error)}`);
        }
      }
      if (mode === 'keychain') return undefined;
      const record = await readFileRecord(key);
      return record ? { record, location: { kind: 'file', path: filePath(key) } } : undefined;
    },

    async set(key, record) {
      let fallbackReason: string | undefined;
      if (mode !== 'file') {
        try {
          await keychainWrite(key, JSON.stringify(record));
          // A copy left by an earlier fallback is stale now.
          await rm(filePath(key), { force: true });
          return { location: { kind: 'keychain' } };
        } catch (error) {
          if (mode === 'keychain') throw new Error(`cannot write to the system keychain: ${firstLine(error)}`);
          fallbackReason = `the system keychain is not available (${firstLine(error)})`;
        }
      }
      const path = await writeFileRecord(key, record);
      return { location: { kind: 'file', path }, ...(fallbackReason ? { fallbackReason } : {}) };
    },

    async delete(key) {
      let removed = false;
      let keychainError: unknown;
      if (mode !== 'file') {
        try {
          removed = await keychainDelete(key);
        } catch (error) {
          keychainError = error;
        }
      }
      if (mode !== 'keychain') {
        const had = (await readFileRecord(key)) !== undefined;
        await rm(filePath(key), { force: true });
        removed ||= had;
      }
      if (mode === 'keychain' && keychainError) throw new Error(`cannot delete from the system keychain: ${firstLine(keychainError)}`);
      return removed;
    },
  };
}

/** In-memory store, for tests and for callers that must not touch disk. */
export function createMemoryOAuthStore(): OAuthStore & { records: Map<string, OAuthRecord> } {
  const records = new Map<string, OAuthRecord>();
  return {
    records,
    async get(key) {
      const record = records.get(key);
      return record ? { record: structuredClone(record), location: { kind: 'file', path: '<memory>' } } : undefined;
    },
    async set(key, record) {
      records.set(key, structuredClone(record));
      return { location: { kind: 'file', path: '<memory>' } };
    },
    async delete(key) {
      return records.delete(key);
    },
  };
}
