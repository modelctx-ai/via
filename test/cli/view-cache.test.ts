import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProviderCatalog, SearchIndex, type CatalogTool, type DocTerms, type McpTool, type ProviderCatalog, type ProviderInput, type RestoredTerms } from '../../src/catalog';
import { CatalogCache, cacheKey } from '../../src/client/catalog-cache';
import { stringHash } from '../../src/hash';
import type { ServerConfig } from '../../src/config/types';
import { inputsHash, ViewCache } from '../../src/cli/view-cache';
import { httpServer } from '../helpers/client';
import { fixtureNames, loadTools } from '../helpers/fixtures';
import { ghConfig, makeSandbox, startFixtureServer, useCleanup, FAKE_TOKEN } from './helpers';

// The prebuilt-catalog cache (view-cache.ts): a snapshot of what the catalog code derives from a
// tool list. It must be invisible - same catalog, same search results - and it must never outlive
// the inputs it was made from.

const FIXTURE_PROVIDERS = fixtureNames('tools');
const FETCHED_AT = 1_800_000_000_000;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'via-view-'));
  dirs.push(dir);
  return join(dir, 'catalog');
}

/** Where the build of `provider` on `server` is kept: one file per server and provider name. */
function viewFile(dir: string, server: ServerConfig, provider: string): string {
  return join(dir, `${cacheKey(server)}.${stringHash(provider).slice(0, 8)}.view.json`);
}

function input(provider: string, tools: McpTool[], extra: Partial<ProviderInput> = {}): ProviderInput {
  return { provider, tools, ...extra };
}

describe('ViewCache round trip', () => {
  it('restores exactly the catalog that was built, and an index that ranks the same', async () => {
    const dir = scratch();
    const cache = new ViewCache(dir, 'fp-1');
    const built = new Map<string, ProviderCatalog>();
    const restored = new Map<string, ProviderCatalog>();
    const restoredTerms = new Map<string, RestoredTerms>();
    for (const name of FIXTURE_PROVIDERS) {
      const tools = loadTools('tools', name);
      const server = httpServer(`http://127.0.0.1:1/${name}`, { name, provider: name });
      const inp = input(name, tools, { deny: [/delete/] });
      const catalog = buildProviderCatalog(inp);
      built.set(name, catalog);
      expect(cache.read(server, inp, { tools, fetchedAt: FETCHED_AT })).toBeUndefined();
      await cache.write(server, inp, { tools, fetchedAt: FETCHED_AT }, catalog);
      const hit = cache.read(server, inp, { tools, fetchedAt: FETCHED_AT });
      expect(hit, name).toBeDefined();
      restored.set(name, hit!.catalog);
      restoredTerms.set(name, hit!.terms);
      // (a restored catalog also knows its size without restoring its tools)
      expect(hit!.catalog, name).toMatchObject(catalog);
      // Tools keep pointing at the raw definitions the caller holds, not at copies.
      for (const tool of hit!.catalog.tools) expect(tools).toContain(tool.def);
    }
    const fresh = { providers: [...built.values()].sort((a, b) => (a.provider < b.provider ? -1 : 1)), warnings: [] };
    const cached = { providers: [...restored.values()].sort((a, b) => (a.provider < b.provider ? -1 : 1)), warnings: [] };
    const freshIndex = new SearchIndex(fresh);
    const cachedIndex = new SearchIndex(cached, undefined, { precomputed: { get: (tool: CatalogTool): DocTerms | undefined => restoredTerms.get(tool.provider)?.get(tool) } });
    expect(cachedIndex.size).toBe(freshIndex.size);
    for (const query of ['create issue', 'search', 'list files', 'send message', 'query', '', 'github/issue', 'dm', 'page']) {
      const summary = (index: SearchIndex) => index.search(query, { limit: 25 }).map((h) => [h.tool.ref, h.tier, h.score]);
      expect(summary(cachedIndex), query).toEqual(summary(freshIndex));
    }
  });

  it('is deterministic: building and restoring twice writes the same file', async () => {
    const tools = loadTools('tools', 'github');
    const server = httpServer('http://127.0.0.1:1/gh', { name: 'gh', provider: 'gh' });
    const inp = input('gh', tools);
    const files: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const dir = scratch();
      await new ViewCache(dir, 'fp-1').write(server, inp, { tools, fetchedAt: FETCHED_AT }, buildProviderCatalog(inp));
      files.push(readFileSync(viewFile(dir, server, 'gh'), 'utf8'));
    }
    expect(files[0]).toBe(files[1]);
  });
});

describe('ViewCache invalidation', () => {
  const tools = loadTools('tools', 'github');
  const server = httpServer('http://127.0.0.1:1/gh', { name: 'gh', provider: 'gh' });
  const base = input('gh', tools, { aliases: ['github'], rename: { issue_read: 'ticket:get' }, deny: [/^gh\/repo/] });
  const listing = { tools, fetchedAt: FETCHED_AT };

  async function primed(): Promise<{ cache: ViewCache; dir: string }> {
    const dir = scratch();
    const cache = new ViewCache(dir, 'fp-1');
    await cache.write(server, base, listing, buildProviderCatalog(base));
    expect(cache.read(server, base, listing)).toBeDefined();
    return { cache, dir };
  }

  it('misses when the tool list was fetched again, or its length changed', async () => {
    const { cache } = await primed();
    expect(cache.read(server, base, { tools, fetchedAt: FETCHED_AT + 1 })).toBeUndefined();
    expect(cache.read(server, base, { tools: tools.slice(1), fetchedAt: FETCHED_AT })).toBeUndefined();
  });

  it('compares the length of the raw cache file when both sides know it, and then never looks at the tools', async () => {
    const dir = scratch();
    const cache = new ViewCache(dir, 'fp-1');
    await cache.write(server, base, { tools, fetchedAt: FETCHED_AT, rawBytes: 4242 }, buildProviderCatalog(base));
    const untouched = (rawBytes: number) => ({
      fetchedAt: FETCHED_AT,
      rawBytes,
      get tools(): McpTool[] {
        throw new Error('the raw list must not be parsed');
      },
    });
    expect(cache.read(server, base, untouched(4242))).toBeDefined();
    expect(cache.read(server, base, untouched(4243))).toBeUndefined();
  });

  it('refuses a definition that is not the tool the snapshot was made for, when it is first used', async () => {
    const { cache } = await primed();
    // Same time and length, a different tool at position 0: only possible by tampering, and caught on use.
    const swapped = tools.map((t, i) => (i === 0 ? { ...t, name: `${t.name}_v2` } : t));
    const hit = cache.read(server, base, { tools: swapped, fetchedAt: FETCHED_AT });
    expect(hit).toBeDefined();
    const first = buildProviderCatalog(base).tools.find((t) => t.def === tools[0])!;
    const restored = hit!.catalog.tools.find((t) => t.rawName === first.rawName);
    if (restored) expect(() => restored.def).toThrow(/does not match/);
  });

  it('shows the size of a provider without parsing the tools, and its tools without parsing the raw list', async () => {
    const dir = scratch();
    const cache = new ViewCache(dir, 'fp-1');
    const built = buildProviderCatalog(base);
    await cache.write(server, base, { tools, fetchedAt: FETCHED_AT, rawBytes: 99 }, built);
    let parsed = 0;
    const listing = {
      fetchedAt: FETCHED_AT,
      rawBytes: 99,
      get tools(): McpTool[] {
        parsed += 1;
        return tools;
      },
    };
    const hit = cache.read(server, base, listing)!;
    const catalog = hit.catalog as ProviderCatalog & { toolCount?: number };
    expect(catalog.toolCount).toBe(built.tools.length);
    expect(parsed).toBe(0);
    // Names, signatures and descriptions come from the snapshot...
    expect(catalog.tools.map((t) => [t.ref, t.description, t.params, t.readOnly, t.destructive])).toEqual(built.tools.map((t) => [t.ref, t.description, t.params, t.readOnly, t.destructive]));
    expect(parsed).toBe(0);
    // ...the schema only when somebody asks for it.
    expect(catalog.tools[0]!.def).toBe(built.tools[0]!.def);
    expect(parsed).toBe(1);
  });

  it('misses under another rules fingerprint (a new version, or an edited data file or catalog source)', async () => {
    const { dir } = await primed();
    expect(new ViewCache(dir, 'fp-2').read(server, base, listing)).toBeUndefined();
    expect(new ViewCache(dir, 'fp-1').read(server, base, listing)).toBeDefined();
  });

  it.each<[string, Partial<ProviderInput>]>([
    ['provider name', { provider: 'gh2' }],
    ['aliases', { aliases: ['git'] }],
    ['rename', { rename: { issue_read: 'ticket:fetch' } }],
    ['deny', { deny: [/^gh\/issue/] }],
    ['deny flags', { deny: [/^gh\/repo/i] }],
  ])('misses when the %s changed', async (_label, change) => {
    const { cache } = await primed();
    expect(cache.read(server, { ...base, ...change }, listing)).toBeUndefined();
  });

  it('does not depend on the order object keys were written in', () => {
    const a = input('gh', tools, { rename: { b: 'x:y', a: 'z:w' } });
    const b = input('gh', tools, { rename: { a: 'z:w', b: 'x:y' } });
    expect(inputsHash(a)).toBe(inputsHash(b));
  });

  it('ignores a file that is corrupt, from another layout, or not a snapshot of this list', async () => {
    const { dir } = await primed();
    // A fresh instance per check: one instance reads each file once per run.
    const cache = (): ViewCache => new ViewCache(dir, 'fp-1');
    const file = viewFile(dir, server, 'gh');
    const good = readFileSync(file, 'utf8');
    for (const bad of ['{not json', '[]', 'null', JSON.stringify({ ...JSON.parse(good), v: 99 }), JSON.stringify({ ...JSON.parse(good), head: { n: tools.length } }), JSON.stringify({ ...JSON.parse(good), head: null }), JSON.stringify({ ...JSON.parse(good), body: 7 })]) {
      writeFileSync(file, bad);
      expect(cache().read(server, base, listing), bad.slice(0, 30)).toBeUndefined();
    }
    writeFileSync(file, good);
    expect(cache().read(server, base, listing)).toBeDefined();
  });

  it('is cleared with the raw list of the server', async () => {
    const { dir } = await primed();
    new CatalogCache(dir).write(server, tools, { fetchedAt: FETCHED_AT });
    new CatalogCache(dir).clear(server);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('keeps a build per provider name when two names share one server', async () => {
    const dir = scratch();
    const other = { ...server, name: 'gh-again', provider: 'gh-again' };
    expect(cacheKey(other)).toBe(cacheKey(server));
    const a = input('gh', tools);
    const b = input('gh-again', tools);
    const cache = new ViewCache(dir, 'fp-1');
    await cache.write(server, a, listing, buildProviderCatalog(a));
    await cache.write(other, b, listing, buildProviderCatalog(b));
    expect(readdirSync(dir).filter((n) => n.endsWith('.view.json'))).toHaveLength(2);
    // A later run finds both: neither provider rebuilds because the other wrote last.
    const later = new ViewCache(dir, 'fp-1');
    expect(later.read(server, a, listing)?.catalog.provider).toBe('gh');
    expect(later.read(other, b, listing)?.catalog.provider).toBe('gh-again');
  });

  it('clears every provider name of the server with its raw list', async () => {
    const dir = scratch();
    const other = { ...server, name: 'gh-again', provider: 'gh-again' };
    const raw = new CatalogCache(dir);
    raw.write(server, tools, { fetchedAt: FETCHED_AT });
    for (const [s, name] of [[server, 'gh'], [other, 'gh-again']] as const) {
      const inp = input(name, tools);
      await new ViewCache(dir, 'fp-1').write(s, inp, listing, buildProviderCatalog(inp));
    }
    expect(readdirSync(dir).filter((n) => n.endsWith('.view.json'))).toHaveLength(2);
    raw.clear(server);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('removes the file name an earlier version wrote, which nothing reads any more', async () => {
    const dir = scratch();
    mkdirSync(dir, { recursive: true });
    const legacy = join(dir, `${cacheKey(server)}.view.json`);
    writeFileSync(legacy, '{}');
    await new ViewCache(dir, 'fp-1').write(server, base, listing, buildProviderCatalog(base));
    expect(readdirSync(dir).filter((n) => n.endsWith('.view.json'))).toEqual([expect.stringMatching(/^[0-9a-f]{32}\.[0-9a-f]{8}\.view\.json$/)]);
  });

  it('survives a directory that cannot be written', async () => {
    const dir = scratch();
    mkdirSync(join(dir, '..'), { recursive: true });
    writeFileSync(dir, 'a file where the directory should be');
    const cache = new ViewCache(dir, 'fp-1');
    await expect(cache.write(server, base, listing, buildProviderCatalog(base))).resolves.toBeDefined();
    expect(cache.read(server, base, listing)).toBeUndefined();
  });
});

describe('ViewCache and credentials', () => {
  it('writes no credential value, literal or referenced, into the cache directory', async () => {
    const SECRET = 'fake-secret-value-that-must-not-be-written';
    const TOKEN_REF = 'env:VIEW_CACHE_TEST_TOKEN';
    const tools = loadTools('tools', 'github');
    const server = httpServer('http://127.0.0.1:1/gh', {
      name: 'gh',
      provider: 'gh',
      headers: { 'X-Api-Key': SECRET },
      auth: { type: 'bearer', bearer: SECRET },
    });
    const server2 = httpServer('http://127.0.0.1:1/gh2', { name: 'gh2', provider: 'gh2', auth: { type: 'bearer', bearer: TOKEN_REF } });
    const dir = scratch();
    const cache = new ViewCache(dir, 'fp-1');
    const raw = new CatalogCache(dir);
    for (const s of [server, server2]) {
      const inp = input(s.provider, tools);
      raw.write(s, tools, { fetchedAt: FETCHED_AT });
      await cache.write(s, inp, { tools, fetchedAt: FETCHED_AT }, buildProviderCatalog(inp));
    }
    const names = readdirSync(dir);
    expect(names.filter((n) => n.endsWith('.view.json'))).toHaveLength(2);
    for (const name of names) {
      const text = readFileSync(join(dir, name), 'utf8');
      expect(text, name).not.toContain(SECRET);
      expect(text, name).not.toContain(TOKEN_REF);
    }
  });
});

describe('browse commands with the build cache', () => {
  async function setup() {
    const srv = await startFixtureServer({ token: FAKE_TOKEN });
    useCleanup(() => srv.close());
    const sb = makeSandbox();
    sb.userConfig(ghConfig(srv.url));
    return { srv, sb };
  }
  const viewFiles = (cacheDir: string): string[] => readdirSync(join(cacheDir, 'catalog')).filter((n) => n.endsWith('.view.json'));

  it('writes a build on the first browse and prints the same thing from it afterwards', async () => {
    const { sb } = await setup();
    const commands = [[], ['gh'], ['gh', 'issue'], ['find', 'issue'], ['find', 'comment'], ['servers']];
    const printed: string[] = [];
    for (const argv of commands) printed.push((await sb.via(argv)).combined);
    expect(viewFiles(sb.cacheDir)).toHaveLength(1);
    // Every later run is served from the snapshot.
    for (const [i, argv] of commands.entries()) expect((await sb.via(argv)).combined, argv.join(' ')).toBe(printed[i]);
    // A sandbox that has no snapshot yet prints exactly the same.
    rmSync(join(sb.cacheDir, 'catalog'), { recursive: true, force: true });
    const cold = await sb.via(['find', 'issue']);
    expect(cold.combined).toBe(printed[3]);
  });

  it('rebuilds when the tool list changes, when deny changes, and when a rename is added', async () => {
    const { srv, sb } = await setup();
    expect((await sb.via(['gh', 'issue'])).stdout).toContain('issue:read ');
    srv.state.tools = srv.state.tools.filter((t) => t.name !== 'issue_read');
    await sb.via(['sync']);
    expect((await sb.via(['gh', 'issue'])).stdout).not.toContain('issue:read ');
    sb.userConfig(ghConfig(srv.url, '    rename: { issue_write: "ticket:file" }\n'));
    expect((await sb.via(['gh'])).stdout).toContain('ticket');
    sb.userConfig(`${ghConfig(srv.url, '    rename: { issue_write: "ticket:file" }\n')}deny: ["^gh/ticket"]\n`);
    const denied = await sb.via(['gh']);
    expect(denied.stdout).not.toContain('ticket');
  });

  it('ignores a corrupt snapshot and carries on', async () => {
    const { sb } = await setup();
    const before = (await sb.via(['find', 'issue'])).combined;
    const dir = join(sb.cacheDir, 'catalog');
    for (const name of viewFiles(sb.cacheDir)) writeFileSync(join(dir, name), '{"v":1,');
    const r = await sb.via(['find', 'issue']);
    expect(r.code).toBe(0);
    expect(r.combined).toBe(before);
  });
});
