// A built provider catalog as plain JSON, and back (discovery.md, "预构建缓存").
//
// Building a catalog (name splitting, signatures, domain scoring) and its search terms is
// deterministic but takes ~0.06 ms per tool in a process that has never run the code: 10-20 ms for
// a few hundred tools, paid by every one-shot `via`. A snapshot keeps the derived data, so a later
// process only parses it. It is split in two so that a command pays for what it shows:
//
//   head  what `via` (the root view) needs: how many tools are visible and the domain verdict;
//   body  the visible tools (names, signatures, descriptions, hints) and their search terms, as a
//         JSON *string* that is parsed when somebody asks for the tools, not when the head is read.
//
// The tool *definitions* (schemas) are not stored: a restored tool reads its `def` from the raw
// `tools/list` on first access, so browsing never parses the schemas of a server, and a call parses
// them for the one provider it touches.
//
// A snapshot is only valid for the tool list and the inputs it was built from; deciding that is the
// caller's job (src/cli/view-cache.ts).
import { assembleProvider } from './provider';
import { docTerms, type DocTerms } from './search';
import type { CatalogRules } from './provider';
import type { CatalogTool, DomainAssignment, McpTool, ParamInfo, ProviderCatalog } from './types';

/** `ProviderCatalog` plus what a restored one knows without restoring its tools. */
export interface RestoredProvider extends ProviderCatalog {
  /** Number of visible tools; reading it does not restore them. */
  toolCount?: number;
}

export interface SnapshotHead {
  /** Number of tools in the raw list the snapshot was built from. */
  n: number;
  /** Number of visible tools (after `deny`). */
  count: number;
  domain: DomainAssignment;
}

/** Flags of a stored tool. */
const RENAMED = 1;
const READ_ONLY = 2;
const DESTRUCTIVE = 4;

/** `[index in the raw list, raw name, resource, verb, canonical name, flags, description, params]`, params as `[name, arg, required]`. */
type SnapshotTool = [number, string, string | null, string | null, string, number, string, Array<[string, string, 0 | 1]>];

interface SnapshotBody {
  t: SnapshotTool[];
  /** Search terms per visible tool, aligned with `t`: `[length, [term, weight, term, weight, ...]]`. */
  x: Array<[number, Array<string | number>]>;
}

/**
 * Keep a built provider as a snapshot, with the search terms of its tools (computed here, so the
 * caller can build its index from them without doing the work twice). `source` is the raw list the
 * provider was built from.
 */
export function snapshotProvider(
  provider: ProviderCatalog,
  source: readonly McpTool[],
  rules?: CatalogRules,
): { head: SnapshotHead; body: string; terms: Map<CatalogTool, DocTerms> } {
  const terms = new Map<CatalogTool, DocTerms>();
  const indexOf = new Map<McpTool, number>(source.map((tool, i) => [tool, i]));
  const body: SnapshotBody = { t: [], x: [] };
  for (const tool of provider.tools) {
    body.t.push([
      indexOf.get(tool.def) ?? -1,
      tool.rawName,
      tool.resource,
      tool.verb,
      tool.name,
      (tool.renamed ? RENAMED : 0) | (tool.readOnly ? READ_ONLY : 0) | (tool.destructive ? DESTRUCTIVE : 0),
      tool.description,
      tool.params.map((p) => [p.name, p.arg, p.required ? 1 : 0]),
    ]);
    const known = docTerms(tool, rules);
    terms.set(tool, known);
    body.x.push([known.length, [...known.pairs]]);
  }
  return { head: { n: source.length, count: provider.tools.length, domain: provider.domain }, body: JSON.stringify(body), terms };
}

function isParams(value: unknown): value is Array<[string, string, 0 | 1]> {
  return Array.isArray(value) && value.every((p) => Array.isArray(p) && p.length === 3 && typeof p[0] === 'string' && typeof p[1] === 'string' && (p[2] === 0 || p[2] === 1));
}

/** The search terms of a restored provider's tools; asking for one restores the tools. */
export interface RestoredTerms {
  get(tool: CatalogTool): DocTerms | undefined;
}

/**
 * The provider catalog and the search terms of its tools, rebuilt from a snapshot; equal to what
 * `buildProviderCatalog` and `docTerms` produce for the list it was made from. `source` returns
 * that raw list (parsed on demand); a restored tool's `def` is read from it when first used.
 *
 * Nothing is parsed here: `tools`, `resources` and `leaves` of the result restore the body on first
 * access. Returns undefined if the head does not look like a snapshot of a list of `rawCount` tools;
 * a body that turns out to be malformed makes the first access throw.
 */
export function restoreProvider(
  provider: string,
  head: unknown,
  body: unknown,
  source: () => readonly McpTool[],
  rawCount?: number,
): { catalog: RestoredProvider; terms: RestoredTerms } | undefined {
  const h = head as Partial<SnapshotHead> | null;
  if (!h || typeof body !== 'string' || typeof h.n !== 'number' || typeof h.count !== 'number' || typeof h.domain !== 'object' || h.domain === null) return undefined;
  if (rawCount !== undefined && h.n !== rawCount) return undefined;
  const domain = h.domain as DomainAssignment;

  let restored: { catalog: ProviderCatalog; terms: Map<CatalogTool, DocTerms> } | undefined;
  const restore = (): { catalog: ProviderCatalog; terms: Map<CatalogTool, DocTerms> } => {
    if (restored) return restored;
    const parsed = JSON.parse(body) as Partial<SnapshotBody>;
    if (!Array.isArray(parsed.t) || !Array.isArray(parsed.x) || parsed.x.length !== parsed.t.length) throw new Error('malformed prebuilt catalog');
    const tools: CatalogTool[] = [];
    const terms = new Map<CatalogTool, DocTerms>();
    for (let i = 0; i < parsed.t.length; i += 1) {
      const item = parsed.t[i];
      if (!Array.isArray(item) || item.length !== 8) throw new Error('malformed prebuilt catalog');
      const [index, rawName, resource, verb, name, flags, description, params] = item;
      const known = parsed.x[i];
      if (typeof index !== 'number' || typeof name !== 'string' || typeof description !== 'string' || typeof flags !== 'number' || !isParams(params)) throw new Error('malformed prebuilt catalog');
      if (!Array.isArray(known) || typeof known[0] !== 'number' || !Array.isArray(known[1]) || known[1].length % 2 !== 0) throw new Error('malformed prebuilt catalog');
      const tool = {
        provider,
        rawName,
        resource,
        verb,
        name,
        ref: `${provider} ${name}`,
        singleRef: `${provider}/${name}`,
        description,
        params: params.map(([pname, arg, required]): ParamInfo => ({ name: pname, arg, required: required === 1 })),
        readOnly: (flags & READ_ONLY) !== 0,
        destructive: (flags & DESTRUCTIVE) !== 0,
        renamed: (flags & RENAMED) !== 0,
      } as unknown as CatalogTool;
      // The definition is the raw tool at `index`: looked up when something needs the schema.
      Object.defineProperty(tool, 'def', {
        enumerable: true,
        get: () => {
          const def = source()[index];
          if (!def || def.name !== rawName) throw new Error(`prebuilt catalog does not match the tool list (${provider}/${rawName})`);
          return def;
        },
      });
      tools.push(tool);
      terms.set(tool, { length: known[0], pairs: known[1] });
    }
    restored = { catalog: assembleProvider(provider, tools, domain), terms };
    return restored;
  };

  const catalog = { provider, domain, toolCount: h.count } as RestoredProvider;
  Object.defineProperties(catalog, {
    tools: { enumerable: true, get: () => restore().catalog.tools },
    resources: { enumerable: true, get: () => restore().catalog.resources },
    leaves: { enumerable: true, get: () => restore().catalog.leaves },
  });
  return { catalog, terms: { get: (tool) => restore().terms.get(tool) } };
}
