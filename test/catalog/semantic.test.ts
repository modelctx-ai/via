import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCatalog, SearchIndex, type CatalogTool, type McpTool } from '../../src/catalog';
import { cacheFileName, embeddingText, endpoint, semanticScores, type SemanticSettings } from '../../src/catalog/semantic';
import { startEmbeddingsServer, type EmbeddingsServer } from '../helpers/embeddings-server';

const SECRET = 'sk-test-embeddings-secret-0001';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function server(options: Parameters<typeof startEmbeddingsServer>[0] = {}): Promise<EmbeddingsServer> {
  const s = await startEmbeddingsServer(options);
  cleanups.push(() => s.close());
  return s;
}

function cacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'via-emb-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'embeddings');
}

function catalogOf(defs: Array<[string, string]>) {
  const tools: McpTool[] = defs.map(([name, description]) => ({ name, description }));
  return buildCatalog([{ provider: 'acme', tools }]);
}

const toolsOf = (catalog: ReturnType<typeof catalogOf>): CatalogTool[] => catalog.providers.flatMap((p) => p.tools);

const WIDGETS = catalogOf([
  ['make_widget', 'Makes a widget.'],
  ['list_widget', 'Lists widgets.'],
  ['delete_widget', 'Deletes a widget.'],
  ['send_note', 'Sends a note.'],
]);

function settings(s: EmbeddingsServer, extra: Partial<SemanticSettings> = {}): SemanticSettings {
  return { url: s.url, model: 'fake-embed', timeoutMs: 2000, indexTimeoutMs: 5000, ...extra };
}

const bearer = (token: string) => async () => ({ authorization: `Bearer ${token}` });
const noAuth = async () => ({});

describe('semanticScores', () => {
  it('scores every tool by cosine similarity to the query', async () => {
    const s = await server({ concepts: { zorp: 'delete' } });
    const result = await semanticScores('zorp widget', toolsOf(WIDGETS), settings(s), { headers: noAuth, cacheDir: cacheDir() });
    expect(result.note).toBeUndefined();
    const scores = result.scores!;
    expect(scores.size).toBe(4);
    const best = [...scores].sort((a, b) => b[1] - a[1])[0]![0];
    expect(best).toBe('acme widget:delete');
    for (const v of scores.values()) {
      expect(v).toBeGreaterThanOrEqual(-1.0001);
      expect(v).toBeLessThanOrEqual(1.0001);
    }
    expect(result.embedded).toBe(4);
  });

  it('posts to <url>/embeddings with the model, the texts and the bearer token', async () => {
    const s = await server({ token: SECRET });
    await semanticScores('delete', toolsOf(WIDGETS), settings(s, { dimensions: 32 }), { headers: bearer(SECRET), cacheDir: cacheDir() });
    expect(s.requests.length).toBeGreaterThan(0);
    for (const r of s.requests) {
      expect(r.path).toBe('/v1/embeddings');
      expect(r.headers.authorization).toBe(`Bearer ${SECRET}`);
      expect(r.body.model).toBe('fake-embed');
      expect(r.body.dimensions).toBe(32);
      expect(r.body.encoding_format).toBe('float');
    }
    expect(s.requests.flatMap((r) => r.body.input ?? [])).toContain(embeddingText(toolsOf(WIDGETS)[0]!));
  });

  it('accepts a full .../embeddings url', () => {
    expect(endpoint('https://h.invalid/v1/')).toBe('https://h.invalid/v1/embeddings');
    expect(endpoint('https://h.invalid/v1/embeddings')).toBe('https://h.invalid/v1/embeddings');
  });

  it('caches tool embeddings: a second run embeds only the query', async () => {
    const s = await server();
    const dir = cacheDir();
    const first = await semanticScores('make a widget', toolsOf(WIDGETS), settings(s), { headers: noAuth, cacheDir: dir });
    expect(first.embedded).toBe(4);
    const before = s.inputs();
    const second = await semanticScores('delete a widget', toolsOf(WIDGETS), settings(s), { headers: noAuth, cacheDir: dir });
    expect(second.embedded).toBe(0);
    expect(s.inputs() - before).toBe(1); // the query
    expect(second.scores!.size).toBe(4);
  });

  it('re-embeds only tools whose text changed, and other models and endpoints use other files', async () => {
    const s = await server();
    const dir = cacheDir();
    await semanticScores('x', toolsOf(WIDGETS), settings(s), { headers: noAuth, cacheDir: dir });
    const changed = catalogOf([
      ['make_widget', 'Makes a widget.'],
      ['list_widget', 'Lists widgets, newest first.'],
      ['delete_widget', 'Deletes a widget.'],
      ['send_note', 'Sends a note.'],
    ]);
    const r = await semanticScores('x', toolsOf(changed), settings(s), { headers: noAuth, cacheDir: dir });
    expect(r.embedded).toBe(1);
    expect(cacheFileName({ url: s.url, model: 'a' })).not.toBe(cacheFileName({ url: s.url, model: 'b' }));
    expect(cacheFileName({ url: s.url, model: 'a' })).not.toBe(cacheFileName({ url: `${s.url}2`, model: 'a' }));
    expect(cacheFileName({ url: s.url, model: 'a' })).not.toBe(cacheFileName({ url: s.url, model: 'a', dimensions: 8 }));
    const other = await semanticScores('x', toolsOf(changed), settings(s, { model: 'other-model' }), { headers: noAuth, cacheDir: dir });
    expect(other.embedded).toBe(4);
    expect(readdirSync(dir).filter((f) => f.endsWith('.bin'))).toHaveLength(2);
  });

  it('stores the cache privately (0700 directory, 0600 file) and never the credential or the endpoint', async () => {
    const s = await server({ token: SECRET });
    const dir = cacheDir();
    await semanticScores('x', toolsOf(WIDGETS), settings(s), { headers: bearer(SECRET), cacheDir: dir });
    // Windows has no mode bits (security.md, "Windows 上的文件权限"); the privacy there is the ACL of the user cache directory.
    const isPosix = process.platform !== 'win32';
    if (isPosix) expect(statSync(dir).mode & 0o777).toBe(0o700);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const file = join(dir, files[0]!);
    if (isPosix) expect(statSync(file).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(file).toString('latin1');
    expect(bytes).not.toContain(SECRET);
    expect(bytes).not.toContain(s.url);
    expect(bytes).not.toContain('127.0.0.1');
  });

  it('ignores a corrupt or foreign cache file', async () => {
    const s = await server();
    const dir = cacheDir();
    await semanticScores('x', toolsOf(WIDGETS), settings(s), { headers: noAuth, cacheDir: dir });
    const file = join(dir, readdirSync(dir)[0]!);
    writeFileSync(file, 'not an embedding cache');
    const r = await semanticScores('x', toolsOf(WIDGETS), settings(s), { headers: noAuth, cacheDir: dir });
    expect(r.scores?.size).toBe(4);
    expect(r.embedded).toBe(4);
  });

  it('falls back with a note when the request times out, without throwing', async () => {
    const s = await server({ delayMs: 600 });
    const started = Date.now();
    const r = await semanticScores('x', toolsOf(WIDGETS), settings(s, { timeoutMs: 100, indexTimeoutMs: 150 }), { headers: noAuth, cacheDir: cacheDir() });
    expect(Date.now() - started).toBeLessThan(550);
    expect(r.scores).toBeUndefined();
    expect(r.note).toMatch(/^timeout after/);
  });

  it('uses the short timeout once everything is cached', async () => {
    const s = await server();
    const dir = cacheDir();
    await semanticScores('x', toolsOf(WIDGETS), settings(s), { headers: noAuth, cacheDir: dir });
    s.set({ delayMs: 600 });
    const started = Date.now();
    const r = await semanticScores('y', toolsOf(WIDGETS), settings(s, { timeoutMs: 100, indexTimeoutMs: 5000 }), { headers: noAuth, cacheDir: dir });
    expect(Date.now() - started).toBeLessThan(500);
    expect(r.note).toMatch(/^timeout after/);
  });

  it('reports HTTP failures by status only, never the response body or the credential', async () => {
    const s = await server({ token: 'something-else' });
    const r = await semanticScores('x', toolsOf(WIDGETS), settings(s), { headers: bearer(SECRET), cacheDir: cacheDir() });
    expect(r.scores).toBeUndefined();
    expect(r.note).toBe('authentication rejected (HTTP 401)');
    expect(r.note).not.toContain(SECRET);
    const e = await server({ status: 503 });
    const down = await semanticScores('x', toolsOf(WIDGETS), settings(e), { headers: bearer(SECRET), cacheDir: cacheDir() });
    expect(down.note).toBe('HTTP 503');
  });

  it('treats malformed answers as failures', async () => {
    for (const rawBody of ['not json', '{"data":[]}', '{"data":[{"embedding":"x"}]}', '{"data":[{"embedding":[1,2]}]}']) {
      const s = await server({ rawBody });
      const r = await semanticScores('x', toolsOf(WIDGETS), settings(s), { headers: noAuth, cacheDir: cacheDir() });
      expect(r.scores, rawBody).toBeUndefined();
      expect(r.note, rawBody).toMatch(/^unexpected response/);
    }
  });

  it('does not follow redirects (the credential would travel with them)', async () => {
    const target = await server();
    const s = await server({ redirectTo: `${target.url}/embeddings` });
    const r = await semanticScores('x', toolsOf(WIDGETS), settings(s), { headers: bearer(SECRET), cacheDir: cacheDir() });
    expect(r.scores).toBeUndefined();
    expect(r.note).toMatch(/^request failed/);
    expect(target.requests).toHaveLength(0);
  });

  it('reports an unreachable endpoint and a credential problem without leaking', async () => {
    const dead = await startEmbeddingsServer();
    await dead.close();
    const r = await semanticScores('x', toolsOf(WIDGETS), settings(dead), { headers: noAuth, cacheDir: cacheDir() });
    expect(r.note).toMatch(/^request failed \(ECONNREFUSED\)$/);
    const s = await server();
    const credential = Object.assign(new Error('credential env:EMB_KEY is not set'), { name: 'CredentialError' });
    const c = await semanticScores('x', toolsOf(WIDGETS), settings(s), { headers: async () => Promise.reject(credential), cacheDir: cacheDir() });
    expect(c.note).toBe('credential env:EMB_KEY is not set');
    expect(s.requests).toHaveLength(0);
  });

  it('keeps what it embedded when a request fails, and the next run only embeds the rest', async () => {
    const many = catalogOf(Array.from({ length: 130 }, (_, i): [string, string] => [`make_thing${i}`, `Makes thing number ${i}.`]));
    const tools = toolsOf(many);
    const s = await server({ failAfter: 2 });
    const dir = cacheDir();
    const first = await semanticScores('make a thing', tools, settings(s), { headers: noAuth, cacheDir: dir });
    expect(first.scores).toBeUndefined();
    expect(first.note).toMatch(/HTTP 500/);
    expect(first.embedded).toBeGreaterThan(0);
    s.set({ failAfter: undefined });
    const second = await semanticScores('make a thing', tools, settings(s), { headers: noAuth, cacheDir: dir });
    expect(second.scores?.size).toBe(130);
    expect(first.embedded + second.embedded).toBe(130);
    const embeddedTexts = s.requests.flatMap((r) => r.body.input ?? []).filter((t) => t !== 'make a thing');
    expect(new Set(embeddedTexts).size).toBe(130);
    expect(embeddedTexts).toHaveLength(130);
  });
});

describe('fusion with BM25 (SearchIndex semantic option)', () => {
  const catalog = WIDGETS;
  const index = new SearchIndex(catalog);
  const scores = (entries: Record<string, number>) => new Map(Object.entries(entries));

  it('adds tools the lexical ranking cannot find, after the canonical matches', () => {
    expect(index.search('zorp').map((h) => h.tool.ref)).toEqual([]);
    const hits = index.search('zorp', { semantic: scores({ 'acme widget:delete': 0.9, 'acme widget:list': 0.1 }) });
    expect(hits.map((h) => h.tool.ref)).toEqual(['acme widget:delete', 'acme widget:list']);
    expect(hits[0]!.tier).toBe(4);
  });

  it('keeps exact, prefix and substring matches of the canonical form first', () => {
    const semantic = scores({ 'acme note:send': 1, 'acme widget:delete': 0.2 });
    const hits = index.search('widget', { semantic });
    expect(hits[0]!.tier).toBeLessThan(4);
    const tiers = hits.map((h) => h.tier);
    expect(tiers).toEqual([...tiers].sort());
  });

  it('fuses the two rankings with reciprocal rank (agreement wins)', () => {
    // Lexically list/delete/make widget tie on `widget`; the embedding prefers delete.
    const lexical = index.search('widgets thing', { limit: 10 }).map((h) => h.tool.ref);
    const fused = index.search('widgets thing', {
      limit: 10,
      semantic: scores({ 'acme widget:delete': 0.9, 'acme widget:list': 0.5, 'acme make-widget': 0.4, 'acme note:send': 0.8 }),
    });
    expect(fused[0]!.tool.ref).toBe('acme widget:delete');
    expect(fused.map((h) => h.tool.ref)).toContain('acme note:send');
    expect(lexical).not.toContain('acme note:send');
    expect(fused.every((h) => typeof h.fused === 'number')).toBe(true);
  });

  it('is deterministic for a given cache: same scores, same order, ties by canonical form', () => {
    const semantic = scores({ 'acme widget:delete': 0.5, 'acme widget:list': 0.5, 'acme make-widget': 0.5, 'acme note:send': 0.5 });
    const a = index.search('zorp', { semantic }).map((h) => h.tool.ref);
    const b = new SearchIndex(catalog).search('zorp', { semantic }).map((h) => h.tool.ref);
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());
  });

  it('leaves lexical results untouched when there are no semantic scores or the query is empty', () => {
    const plain = index.search('widget').map((h) => h.tool.ref);
    expect(index.search('widget', {}).map((h) => h.tool.ref)).toEqual(plain);
    expect(index.search('', { semantic: scores({ 'acme note:send': 1 }) }).map((h) => h.tool.ref)).toEqual(index.search('').map((h) => h.tool.ref));
  });
});

describe('cache files', () => {
  it('are not created when nothing was embedded', async () => {
    const s = await server({ status: 500 });
    const dir = cacheDir();
    await semanticScores('x', toolsOf(WIDGETS), settings(s), { headers: noAuth, cacheDir: dir });
    expect(existsSync(dir)).toBe(false);
  });
});
