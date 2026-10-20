// Optional embedding retrieval for `via find` (discovery.md, "语义检索"; ADR 0011). Loaded only when
// `search.semantic` is configured, so it costs nothing otherwise. This module knows nothing about
// configuration or credentials: the caller passes resolved request headers.
//
// Tool descriptions are embedded once and cached on disk, keyed by a hash of the text, in one file
// per (endpoint, model, dimensions). At query time only the query is embedded. Every failure falls
// back to lexical ranking and is reported as a short note; the note never contains a header value,
// a response body or the endpoint.
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CatalogTool } from './types';

export interface SemanticSettings {
  /** Base URL or full `…/embeddings` URL. */
  url: string;
  model: string;
  dimensions?: number;
  /** Deadline for the whole step when only the query needs embedding. */
  timeoutMs: number;
  /** Deadline when tools still need embedding. */
  indexTimeoutMs: number;
}

export interface SemanticDeps {
  /** Request headers including authentication; resolved by the caller, never logged here. */
  headers: () => Promise<Record<string, string>>;
  /** Directory of the embedding cache (created with mode 0700). */
  cacheDir: string;
  fetch?: typeof fetch;
}

export interface SemanticResult {
  /** Cosine similarity per `CatalogTool.ref`; absent when the semantic step did not complete. */
  scores?: Map<string, number>;
  /** Why the step did not complete, for the meta line. */
  note?: string;
  /** Tools embedded by this call (cache misses that were filled). */
  embedded: number;
}

const BATCH_SIZE = 64;
const CONCURRENCY = 4;
const MAX_DESCRIPTION = 600;
/** Entries beyond this are dropped (unused ones first) when the cache is written. */
const MAX_CACHE_ENTRIES = 20_000;
const MAGIC = 'VIAEMB1\n';

class SemanticError extends Error {}

/** What is embedded for a tool: its canonical name, description and parameter names. */
export function embeddingText(tool: CatalogTool): string {
  const description = tool.description.replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION);
  const params = tool.params.map((p) => p.name).join(', ');
  return `${tool.provider} ${tool.name}: ${description}${params ? ` (parameters: ${params})` : ''}`;
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Cache file for one endpoint/model/dimensions combination. The URL is hashed, never stored. */
export function cacheFileName(settings: Pick<SemanticSettings, 'url' | 'model' | 'dimensions'>): string {
  return `${sha(JSON.stringify([endpoint(settings.url), settings.model, settings.dimensions ?? null])).slice(0, 24)}.bin`;
}

export function endpoint(url: string): string {
  const base = url.replace(/\/+$/, '');
  return base.endsWith('/embeddings') ? base : `${base}/embeddings`;
}

// Cache -----------------------------------------------------------------------------------------

interface Cache {
  dim: number;
  vectors: Map<string, Float32Array>;
}

function emptyCache(): Cache {
  return { dim: 0, vectors: new Map() };
}

async function readCache(file: string, model: string): Promise<Cache> {
  try {
    const buf = await readFile(file);
    if (buf.length < 12 || buf.toString('latin1', 0, MAGIC.length) !== MAGIC) return emptyCache();
    const headerLength = buf.readUInt32LE(MAGIC.length);
    const dataStart = MAGIC.length + 4 + headerLength;
    const header = JSON.parse(buf.toString('utf8', MAGIC.length + 4, dataStart)) as { model?: unknown; dim?: unknown; ids?: unknown };
    if (header.model !== model || typeof header.dim !== 'number' || !Array.isArray(header.ids)) return emptyCache();
    const { dim } = header;
    const ids = header.ids as string[];
    if (dim < 1 || buf.length - dataStart !== ids.length * dim * 4) return emptyCache();
    // Copy so the floats are aligned whatever the buffer's offset is.
    const floats = new Float32Array(buf.buffer.slice(buf.byteOffset + dataStart, buf.byteOffset + buf.length));
    const vectors = new Map<string, Float32Array>();
    ids.forEach((id, i) => vectors.set(id, floats.subarray(i * dim, (i + 1) * dim)));
    return { dim, vectors };
  } catch {
    return emptyCache();
  }
}

async function writeCache(file: string, model: string, cache: Cache, used: ReadonlySet<string>): Promise<void> {
  try {
    let ids = [...cache.vectors.keys()];
    if (ids.length > MAX_CACHE_ENTRIES) ids = ids.filter((id) => used.has(id));
    const header = Buffer.from(JSON.stringify({ model, dim: cache.dim, ids }), 'utf8');
    const lead = Buffer.alloc(MAGIC.length + 4);
    lead.write(MAGIC, 'latin1');
    lead.writeUInt32LE(header.length, MAGIC.length);
    const data = new Float32Array(ids.length * cache.dim);
    ids.forEach((id, i) => data.set(cache.vectors.get(id)!, i * cache.dim));
    const dir = dirname(file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => undefined);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, Buffer.concat([lead, header, Buffer.from(data.buffer, data.byteOffset, data.byteLength)]), { mode: 0o600 });
    await rename(tmp, file).catch(async (error) => {
      await rm(tmp, { force: true });
      throw error;
    });
  } catch {
    // A cache that cannot be written only costs the next run a request.
  }
}

// Embedding requests ------------------------------------------------------------------------------

function normalized(values: number[]): Float32Array {
  const out = Float32Array.from(values);
  let sum = 0;
  for (const v of out) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < out.length; i += 1) out[i] = out[i]! / norm;
  return out;
}

function describeFailure(error: unknown, timeoutMs: number): string {
  if (error instanceof SemanticError) return error.message;
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return `timeout after ${Math.round(timeoutMs / 100) / 10}s`;
  const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? `request failed (${code})` : 'request failed';
}

async function embed(
  inputs: string[],
  settings: SemanticSettings,
  headers: Record<string, string>,
  signal: AbortSignal,
  doFetch: typeof fetch,
): Promise<Float32Array[]> {
  const body: Record<string, unknown> = { model: settings.model, input: inputs, encoding_format: 'float' };
  if (settings.dimensions !== undefined) body.dimensions = settings.dimensions;
  const response = await doFetch(endpoint(settings.url), {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal,
    // A redirect would send the credentials to another host.
    redirect: 'error',
  });
  if (!response.ok) {
    // The body is never read into a message: servers sometimes echo the request.
    await response.body?.cancel().catch(() => undefined);
    throw new SemanticError(response.status === 401 || response.status === 403 ? `authentication rejected (HTTP ${response.status})` : `HTTP ${response.status}`);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SemanticError('unexpected response');
  }
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length !== inputs.length) throw new SemanticError('unexpected response');
  const rows = data.map((row, i) => ({ index: typeof row?.index === 'number' ? (row.index as number) : i, embedding: row?.embedding as unknown }));
  rows.sort((a, b) => a.index - b.index);
  const vectors: Float32Array[] = [];
  for (const { embedding } of rows) {
    if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      throw new SemanticError('unexpected response');
    }
    vectors.push(normalized(embedding as number[]));
  }
  if (new Set(vectors.map((v) => v.length)).size !== 1) throw new SemanticError('unexpected response');
  return vectors;
}

/** Run `tasks` with at most `limit` in flight; every task settles, so completed work is kept. */
async function pool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= tasks.length) return;
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]!() };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// Scoring -----------------------------------------------------------------------------------------

/**
 * Cosine similarity of the query to every tool. Never throws and never returns a partial ranking:
 * when the query or any tool could not be embedded in time, `scores` is absent and `note` says why.
 * Embeddings that were obtained are cached either way, so a later run continues where this stopped.
 */
export async function semanticScores(
  query: string,
  tools: readonly CatalogTool[],
  settings: SemanticSettings,
  deps: SemanticDeps,
): Promise<SemanticResult> {
  const file = join(deps.cacheDir, cacheFileName(settings));
  const cache = await readCache(file, settings.model);
  const texts = new Map<string, string>(); // hash -> text, in catalog order
  const hashes = tools.map((tool) => {
    const text = embeddingText(tool);
    const hash = sha(text).slice(0, 24);
    texts.set(hash, text);
    return hash;
  });
  const missing = [...texts.keys()].filter((hash) => !cache.vectors.has(hash));

  const timeoutMs = missing.length > 0 ? settings.indexTimeoutMs : settings.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const doFetch = deps.fetch ?? fetch;
  let embedded = 0;
  try {
    const headers = await deps.headers();
    const queryTask = embed([query], settings, headers, controller.signal, doFetch);
    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += BATCH_SIZE) batches.push(missing.slice(i, i + BATCH_SIZE));
    const toolTask = pool(
      batches.map((batch) => async () => {
        const vectors = await embed(batch.map((h) => texts.get(h)!), settings, headers, controller.signal, doFetch);
        // A different width than the cache holds means the endpoint changed behind the same name.
        if (cache.dim !== 0 && vectors[0]!.length !== cache.dim) {
          cache.vectors.clear();
          cache.dim = 0;
        }
        cache.dim = vectors[0]!.length;
        batch.forEach((hash, i) => cache.vectors.set(hash, vectors[i]!));
        embedded += batch.length;
      }),
      CONCURRENCY,
    );
    const [queryResult, toolResults] = await Promise.all([
      queryTask.then(
        (value) => ({ ok: true as const, value }),
        (reason: unknown) => ({ ok: false as const, reason }),
      ),
      toolTask,
    ]);

    if (embedded > 0) await writeCache(file, settings.model, cache, new Set(hashes));
    const failed = toolResults.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (!queryResult.ok) return { note: describeFailure(queryResult.reason, timeoutMs), embedded };
    if (failed) return { note: `${describeFailure(failed.reason, timeoutMs)} while embedding tools; ${hashes.filter((h) => cache.vectors.has(h)).length}/${hashes.length} cached, run find again to continue`, embedded };

    const q = queryResult.value[0]!;
    if (cache.dim !== q.length) return { note: 'unexpected response', embedded };
    const scores = new Map<string, number>();
    tools.forEach((tool, i) => {
      const v = cache.vectors.get(hashes[i]!)!;
      let dot = 0;
      for (let k = 0; k < v.length; k += 1) dot += v[k]! * q[k]!;
      scores.set(tool.ref, dot);
    });
    return { scores, embedded };
  } catch (error) {
    // Credential resolution failed: its message names the reference, never the value.
    if (error instanceof Error && error.name === 'CredentialError') return { note: error.message, embedded };
    return { note: describeFailure(error, timeoutMs), embedded };
  } finally {
    clearTimeout(timer);
  }
}
