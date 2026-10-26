// Disk cache of built provider catalogs (discovery.md, "预构建缓存"). Next to the raw `tools/list`
// of `catalog-cache.ts` it keeps what `buildProviderCatalog` derives from it, as a snapshot
// (src/catalog/snapshot.ts), so a one-shot process parses JSON instead of re-running the naming,
// signature and search-term code on every tool - and, for a view that does not show the schemas,
// never parses the raw list at all.
//
// A snapshot is reused only when all of these match what the current run would build from:
//   - the rules fingerprint (version, data files and catalog code of the running build),
//   - the raw list it was derived from: the `fetchedAt` of the listing (any refetch changes it) and
//     the length of the cache file's text, or the number of tools when the list did not come from a
//     cache file,
//   - every other input of the build: provider name, aliases, `rename` and `deny`.
// Anything else (a different file layout, a corrupt file, a snapshot that does not fit the raw list)
// is a miss and the catalog is built as before. Nothing credential-bearing is stored: the file holds
// names, parameter names, descriptions and search terms of the tool list, like the raw cache.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { restoreProvider, snapshotProvider, type RestoredTerms, type SnapshotHead } from '../catalog/snapshot';
import type { ProviderInput } from '../catalog/provider';
import type { DocTerms } from '../catalog/search';
import type { CatalogTool, McpTool, ProviderCatalog } from '../catalog/types';
import type { ServerConfig } from '../config/types';
import { stringHash } from '../hash';
import { cacheKey } from './catalog-cache';

/** Bumped when the file layout changes. */
const VIEW_VERSION = 5;

/** The call examples in a file are written for one platform's quoting (arguments.md, "调用示例"): a file from the other kind is a miss. */
const PLATFORM_KIND = process.platform === 'win32' ? 'win' : 'posix';

interface ViewFile {
  v: number;
  fp: string;
  /** Hash of the build inputs other than the raw list. */
  inputs: string;
  /** Quoting rules the examples were written for (`PLATFORM_KIND`). */
  plat: string;
  /** 1 when the tools carry their call examples (written for `via find`), 0 when they were left out. */
  ex: number;
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
  /** Whether the tools carry their call examples (`CatalogTool#exampleArgs`). */
  examples: boolean;
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

const hashes = new WeakMap<ProviderInput, string>();

/** Everything `buildProviderCatalog` reads besides the tool list, as a hash (once per input object). */
export function inputsHash(input: ProviderInput): string {
  let hash = hashes.get(input);
  if (hash === undefined) {
    hash = computeInputsHash(input);
    hashes.set(input, hash);
  }
  return hash;
}

function computeInputsHash(input: ProviderInput): string {
  return stringHash(
    canonical({
      provider: input.provider,
      aliases: input.aliases ?? [],
      rename: input.rename ?? {},
      deny: (input.deny ?? []).map((re) => [re.source, re.flags]),
    }),
  );
}

/** The function that writes the call example of a tool (arguments.md, "调用示例"), or none if it cannot be loaded. */
async function callExamples(): Promise<((tool: CatalogTool) => string | undefined) | undefined> {
  try {
    return (await import('./args/example')).callExampleArgs;
  } catch {
    return undefined;
  }
}

export class ViewCache {
  constructor(
    /** `<cache dir>/catalog`, the directory of the raw cache. */
    private readonly dir: string,
    /** `rulesFingerprint()` of the running build. */
    private readonly fingerprint: string,
  ) {}

  /**
   * One file per server and provider name: the same server configured under two names (say, in two
   * agent frameworks) must not overwrite each other's build on every run.
   */
  private file(server: ServerConfig, input: ProviderInput): string {
    return join(this.dir, `${cacheKey(server)}.${stringHash(input.provider).slice(0, 8)}.view.json`);
  }

  /** Files already read in this run, so `peek` and `read` of one provider parse its file once. */
  private readonly loaded = new Map<string, { inputs: string; data: ViewFile | undefined }>();

  private load(server: ServerConfig, input: ProviderInput): ViewFile | undefined {
    const file = this.file(server, input);
    const inputs = inputsHash(input);
    const known = this.loaded.get(file);
    if (known && known.inputs === inputs) return known.data;
    let data: ViewFile | undefined;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ViewFile> | null;
      if (parsed && parsed.v === VIEW_VERSION && parsed.fp === this.fingerprint && typeof parsed.at === 'number' && parsed.inputs === inputs && parsed.plat === PLATFORM_KIND) data = parsed as ViewFile;
    } catch {
      data = undefined;
    }
    this.loaded.set(file, { inputs, data });
    return data;
  }

  /**
   * The `fetchedAt` of the cached build for these inputs, if there is one: the list it was made
   * from. A caller that can ask its source "has the list changed since" asks about this one.
   */
  peek(server: ServerConfig, input: ProviderInput): number | undefined {
    return this.load(server, input)?.at;
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
      return restored ? { catalog: restored.catalog, terms: restored.terms, examples: data.ex === 1 } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Keep a build for later runs and return its search terms. Best effort, like the raw cache: a
   * cache that cannot be written must never fail a command.
   *
   * `examples` also writes the call example of every tool (and sets it on the tools of `catalog`).
   * They are made from the schemas, which a browse never reads, so only `via find` asks for them;
   * writing them again for a catalog restored without them is how a file gets them later.
   */
  async write(server: ServerConfig, input: ProviderInput, listing: RawListing, catalog: ProviderCatalog, options: { examples?: boolean } = {}): Promise<Map<CatalogTool, DocTerms>> {
    const exampleOf = options.examples ? await callExamples() : undefined;
    const { head, body, terms } = snapshotProvider(catalog, listing.tools, undefined, exampleOf);
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(this.dir, 0o700);
      } catch {
        // best effort (no-op on Windows)
      }
      const file = this.file(server, input);
      const tmp = `${file}.${process.pid}.tmp`;
      const content: ViewFile = {
        v: VIEW_VERSION,
        fp: this.fingerprint,
        inputs: inputsHash(input),
        plat: PLATFORM_KIND,
        ex: exampleOf ? 1 : 0,
        at: listing.fetchedAt,
        ...(listing.rawBytes !== undefined ? { bytes: listing.rawBytes } : {}),
        head,
        body,
      };
      writeFileSync(tmp, JSON.stringify(content), { mode: 0o600 });
      renameSync(tmp, file);
      // The earlier file name (one per server, whichever provider wrote last): nothing reads it any more.
      rmSync(join(this.dir, `${cacheKey(server)}.view.json`), { force: true });
      this.loaded.delete(file);
    } catch {
      // ignore
    }
    return terms;
  }
}
