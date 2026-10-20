// Glue between `via find` and the optional embedding retrieval (discovery.md, "语义检索"; ADR 0011).
// Imported only when `search.semantic` is configured, so the default `find` never loads it or the
// module behind it. Runs in the CLI process: the catalog is computed here, the embeddings are
// cached on disk, and the daemon is not involved.
import { join } from 'node:path';
import type { Catalog } from '../catalog';
import { semanticScores, type SemanticResult } from '../catalog/semantic';
import type { SemanticSearchConfig } from '../config';
import type { App } from './app';

/** Authentication headers of the embedding endpoint; credential references are resolved here, in memory. */
async function authHeaders(app: App, config: SemanticSearchConfig): Promise<Record<string, string>> {
  const { auth } = config;
  if (auth.type === 'none') return {};
  const resolver = await app.resolver();
  if (auth.type === 'bearer') return { authorization: `Bearer ${await resolver.resolve(auth.bearer, config.origin)}` };
  const headers: Record<string, string> = {};
  for (const [name, ref] of Object.entries(auth.headers)) headers[name.toLowerCase()] = await resolver.resolve(ref, config.origin);
  return headers;
}

/** Embedding scores for `query` against every tool of the catalog; see `semanticScores` for the failure contract. */
export function semanticFind(app: App, config: SemanticSearchConfig, catalog: Catalog, query: string): Promise<SemanticResult> {
  return semanticScores(
    query,
    catalog.providers.flatMap((p) => p.tools),
    {
      url: config.url,
      model: config.model,
      ...(config.dimensions !== undefined ? { dimensions: config.dimensions } : {}),
      timeoutMs: config.timeout * 1000,
      indexTimeoutMs: config.indexTimeout * 1000,
    },
    { headers: () => authHeaders(app, config), cacheDir: join(app.cacheDir, 'embeddings') },
  );
}
