// Disk cache of `tools/list` per server (discovery.md, "缓存"). In-process mode would otherwise
// connect to every server on every command. The raw list is stored; splitting, domains and the
// index are recomputed on load, so rule upgrades never need a cache flush.
//
// The key is a hash of the server's transport definition: command, args, cwd, URL, the *names* of
// env variables and headers, and the credential *references* (never resolved values). A literal
// credential only ever enters the hash, which is one-way.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpTool } from '../catalog/types';
import { parseCredentialRef } from '../config/credentials';
import { sha256Hex } from '../sha256';
import type { ServerConfig } from '../config/types';

/** Default time to live of a cached `tools/list` (discovery.md). */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/** Bumped when the file layout changes. */
const CACHE_VERSION = 1;

interface CacheFile {
  version: number;
  fetchedAt: number;
  tools: McpTool[];
}

export interface CacheEntry {
  fetchedAt: number;
  /** Length of the file's text; with `fetchedAt` it identifies the file's content for the prebuilt-catalog cache. */
  rawBytes: number;
  /** The tools; parsed on first access, so a command that does not need them never pays for them. */
  readonly tools: McpTool[];
}

/** What `write` below puts first in every file, so `read` can learn the age without parsing the tools. */
const FILE_HEAD = /^\{"version":(\d+),"fetchedAt":(\d+),"tools":(?=\[)/;

function sortedKeys(record: Record<string, string>): string[] {
  return Object.keys(record).sort();
}

/** Credential-bearing values contribute their reference text; plain values contribute nothing. */
function refsOf(record: Record<string, string>): Array<[string, string]> {
  return sortedKeys(record).map((k) => [k, parseCredentialRef(record[k]!).kind === 'literal' ? '' : record[k]!]);
}

const keys = new WeakMap<ServerConfig, { transport: unknown; auth: unknown; key: string }>();

/**
 * Hash of everything that decides which tools a server lists, without any resolved credential.
 * Computed once per server object and run: the raw list, the prebuilt catalog and the writes all
 * ask for it.
 */
export function cacheKey(server: ServerConfig): string {
  const known = keys.get(server);
  if (known && known.transport === server.transport && known.auth === server.auth) return known.key;
  const key = computeKey(server);
  keys.set(server, { transport: server.transport, auth: server.auth, key });
  return key;
}

function computeKey(server: ServerConfig): string {
  const { transport, auth } = server;
  const transportPart =
    transport.type === 'stdio'
      ? { type: 'stdio', command: transport.command, args: transport.args, cwd: transport.cwd ?? null, env: refsOf(transport.env) }
      : { type: 'http', url: transport.url, headers: refsOf(transport.headers) };
  const authPart =
    auth.type === 'bearer'
      ? { type: 'bearer', ref: auth.bearer }
      : auth.type === 'headers'
        ? { type: 'headers', refs: sortedKeys(auth.headers).map((k) => [k, auth.headers[k]]) }
        : auth.type === 'oauth'
          ? { type: 'oauth', scopes: auth.scopes ?? [], clientId: auth.clientId ?? null }
          : { type: 'none' };
  return sha256Hex(JSON.stringify({ v: CACHE_VERSION, transport: transportPart, auth: authPart })).slice(0, 32);
}

export class CatalogCache {
  constructor(
    /** `<cache dir>/catalog`. */
    private readonly dir: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = CATALOG_TTL_MS,
  ) {}

  private file(server: ServerConfig): string {
    return join(this.dir, `${cacheKey(server)}.json`);
  }

  /** A fresh entry, or undefined when there is none, it is expired or unreadable. */
  read(server: ServerConfig): CacheEntry | undefined {
    try {
      const text = readFileSync(this.file(server), 'utf8');
      const head = FILE_HEAD.exec(text);
      if (head && text.endsWith(']}')) {
        // The layout `write` produces: age and version come from the head, the tools array is
        // parsed only if somebody reads it.
        if (Number(head[1]) !== CACHE_VERSION) return undefined;
        const fetchedAt = Number(head[2]);
        if (this.now() - fetchedAt > this.ttlMs) return undefined;
        let tools: McpTool[] | undefined;
        return {
          fetchedAt,
          rawBytes: text.length,
          get tools(): McpTool[] {
            return (tools ??= JSON.parse(text.slice(head[0].length, -1)) as McpTool[]);
          },
        };
      }
      const data = JSON.parse(text) as Partial<CacheFile>;
      if (data.version !== CACHE_VERSION || typeof data.fetchedAt !== 'number' || !Array.isArray(data.tools)) return undefined;
      if (this.now() - data.fetchedAt > this.ttlMs) return undefined;
      return { tools: data.tools, fetchedAt: data.fetchedAt, rawBytes: text.length };
    } catch {
      return undefined;
    }
  }

  /**
   * Best effort: a cache that cannot be written must never fail a command. `fetchedAt` defaults to
   * now; callers that report the time to their own caller pass the value they report, so the file
   * and the report agree (the prebuilt-catalog cache is keyed by it). Returns the length of the
   * text written, or undefined when nothing could be written.
   */
  write(server: ServerConfig, tools: McpTool[], fetchedAt: number = this.now()): number | undefined {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(this.dir, 0o700);
      } catch {
        // best effort (no-op on Windows)
      }
      const file = this.file(server);
      const tmp = `${file}.${process.pid}.tmp`;
      const body: CacheFile = { version: CACHE_VERSION, fetchedAt, tools };
      const text = JSON.stringify(body);
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, file);
      return text.length;
    } catch {
      return undefined;
    }
  }

  clear(server: ServerConfig): void {
    rmSync(this.file(server), { force: true });
    rmSync(join(this.dir, `${cacheKey(server)}.view.json`), { force: true });
  }
}
