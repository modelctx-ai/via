// Disk cache of built provider catalogs (discovery.md, "预构建缓存"). Next to the raw `tools/list`
// of `catalog-cache.ts` it keeps what `buildProviderCatalog` derives from it, as a snapshot
// (src/catalog/snapshot.ts), so a one-shot process parses JSON instead of re-running the naming,
// signature, domain and search-term code on every tool - and, for a view that does not show the
// schemas, never parses the raw list at all.
//
// A snapshot is reused only when all of these match what the current run would build from:
//   - the rules fingerprint (version, data files and catalog code of the running build),
//   - the raw list it was derived from: the `fetchedAt` of the listing (any refetch changes it) and
//     the length of the cache file's text, or the number of tools when the list did not come from a
//     cache file,
//   - every other input of the build: provider name, aliases, `rename`, `deny`, identity, the
//     server's `domain` and the top-level `domains`.
// Anything else (a different file layout, a corrupt file, a snapshot that does not fit the raw list)
// is a miss and the catalog is built as before. Nothing credential-bearing is stored: the file holds
// names, parameter names, descriptions, domain verdicts and search terms of the tool list, like the
// raw cache.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { restoreProvider, snapshotProvider, type RestoredTerms, type SnapshotHead } from '../catalog/snapshot';
import type { ProviderInput } from '../catalog/provider';
import type { DocTerms } from '../catalog/search';
import type { CatalogTool, McpTool, ProviderCatalog } from '../catalog/types';
import type { ServerConfig } from '../config/types';
import { stringHash } from '../hash';
import { cacheKey } from './catalog-cache';

/** Bumped when the file layout changes. */
const VIEW_VERSION = 2;

interface ViewFile {
  v: number;
  fp: string;
  /** Hash of the build inputs other than the raw list. */
  inputs: string;
  /** `fetchedAt` of the raw list the snapshot was derived from. */
  at: number;
  /** Length of the raw cache file's text, when the list came from one. */
  bytes?: number;
  head: SnapshotHead;
  body: string;
}

/** The raw list a build is made from. `tools` may parse on first access (see `Listing`). */
export interface RawListing {
  readonly tools: McpTool[];
  fetchedAt: number;
  rawBytes?: number;
}

export interface CachedView {
  catalog: ProviderCatalog;
  terms: RestoredTerms;
}

/** JSON with object keys in sorted order, so equal values always hash alike. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
      return sorted;
    }
    return v;
  });
}

/** Everything `buildProviderCatalog` reads besides the tool list, as a hash. */
export function inputsHash(input: ProviderInput): string {
  return stringHash(
    canonical({
      provider: input.provider,
      aliases: input.aliases ?? [],
      rename: input.rename ?? {},
      deny: (input.deny ?? []).map((re) => [re.source, re.flags]),
      identity: input.identity ?? null,
      configDomain: input.configDomain ?? null,
      customDomains: input.customDomains ?? {},
    }),
  );
}

export class ViewCache {
  constructor(
    /** `<cache dir>/catalog`, the directory of the raw cache. */
    private readonly dir: string,
    /** `rulesFingerprint()` of the running build. */
    private readonly fingerprint: string,
  ) {}

  private file(server: ServerConfig): string {
    return join(this.dir, `${cacheKey(server)}.view.json`);
  }

  private load(server: ServerConfig, input: ProviderInput): ViewFile | undefined {
    try {
      const data = JSON.parse(readFileSync(this.file(server), 'utf8')) as Partial<ViewFile> | null;
      if (!data || data.v !== VIEW_VERSION || data.fp !== this.fingerprint || typeof data.at !== 'number' || data.inputs !== inputsHash(input)) return undefined;
      return data as ViewFile;
    } catch {
      return undefined;
    }
  }

  /** The cached build of this provider for this listing, or undefined. */
  read(server: ServerConfig, input: ProviderInput, listing: RawListing): CachedView | undefined {
    const data = this.load(server, input);
    if (!data || data.at !== listing.fetchedAt) return undefined;
    // Same content as the file the snapshot was made from? Compare file lengths when both know
    // them (nothing is parsed), tool counts otherwise.
    if (data.bytes !== undefined && listing.rawBytes !== undefined) {
      if (data.bytes !== listing.rawBytes) return undefined;
    } else if (listing.tools.length !== data.head?.n) {
      return undefined;
    }
    try {
      const restored = restoreProvider(input.provider, data.head, data.body, () => listing.tools);
      return restored ? { catalog: restored.catalog, terms: restored.terms } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Keep a build for later runs and return its search terms. Best effort, like the raw cache: a
   * cache that cannot be written must never fail a command.
   */
  write(server: ServerConfig, input: ProviderInput, listing: RawListing, catalog: ProviderCatalog): Map<CatalogTool, DocTerms> {
    const { head, body, terms } = snapshotProvider(catalog, listing.tools);
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(this.dir, 0o700);
      } catch {
        // best effort (no-op on Windows)
      }
      const file = this.file(server);
      const tmp = `${file}.${process.pid}.tmp`;
      const content: ViewFile = {
        v: VIEW_VERSION,
        fp: this.fingerprint,
        inputs: inputsHash(input),
        at: listing.fetchedAt,
        ...(listing.rawBytes !== undefined ? { bytes: listing.rawBytes } : {}),
        head,
        body,
      };
      writeFileSync(tmp, JSON.stringify(content), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      // ignore
    }
    return terms;
  }
}
