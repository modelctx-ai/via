import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CatalogCache, cacheKey, CATALOG_TTL_MS } from '../../src/cli/catalog-cache';
import type { ServerConfig } from '../../src/config';
import { httpServer, stdioServer } from '../helpers/client';
import { defaultGeneration } from '../helpers/generation';
import { CLI_STDIO_SERVER, FAKE_TOKEN, ghConfig, makeSandbox, startFixtureServer, useCleanup } from './helpers';


const T0 = 1_800_000_000_000;

async function setup() {
  const srv = await startFixtureServer({ token: FAKE_TOKEN });
  useCleanup(() => srv.close());
  const sb = makeSandbox();
  sb.userConfig(ghConfig(srv.url));
  return { srv, sb };
}

describe('catalog cache', () => {
  it('lists a server once; later commands read the disk cache', async () => {
    const { srv, sb } = await setup();
    await sb.via(['gh']);
    expect(srv.state.listCalls).toBe(1);
    await sb.via(['gh', 'issue']);
    await sb.via([]);
    await sb.via(['find', 'issue']);
    await sb.via(['gh', 'whoami']);
    expect(srv.state.listCalls).toBe(1);
  });

  it('expires after 24 hours', async () => {
    const { srv, sb } = await setup();
    await sb.via(['gh'], { now: T0 });
    await sb.via(['gh'], { now: T0 + CATALOG_TTL_MS - 1000 });
    expect(srv.state.listCalls).toBe(1);
    await sb.via(['gh'], { now: T0 + CATALOG_TTL_MS + 1000 });
    expect(srv.state.listCalls).toBe(2);
  });

  it('`via sync` refreshes every server, `via sync <provider>` just one', async () => {
    const { srv, sb } = await setup();
    await sb.via(['gh']);
    const all = await sb.via(['sync']);
    expect(all.code).toBe(0);
    expect(all.stdout).toBe('gh  14 tools\n');
    expect(srv.state.listCalls).toBe(2);
    const one = await sb.via(['sync', 'G']);
    expect(one.stdout).toBe('gh  14 tools\n');
    expect(srv.state.listCalls).toBe(3);
    srv.state.tools = srv.state.tools.slice(0, 2);
    await sb.via(['sync']);
    expect((await sb.via([])).stdout).toContain('2 tools');
  });

  it('`via sync` reports failures per provider and exits with the worst code', async () => {
    const { srv, sb } = await setup();
    sb.userConfig(`${ghConfig(srv.url)}  down:\n    url: http://127.0.0.1:1/mcp\n  nokey:\n    url: ${srv.url}\n    auth: { bearer: "env:MISSING_KEY" }\n`);
    const r = await sb.via(['sync']);
    expect(r.code).toBe(6);
    expect(r.stdout).toMatch(/^down {3}failed: cannot start down/m);
    expect(r.stdout).toMatch(/^gh {5}14 tools$/m);
    expect(r.stdout).toMatch(/^nokey {2}needs auth: environment variable MISSING_KEY is not set/m);
    expect(r.stderr).toBe('next: via doctor\n');
  });

  it('does not use the cache for another definition of the same server', async () => {
    const { srv, sb } = await setup();
    await sb.via(['gh']);
    const other = await startFixtureServer({ token: FAKE_TOKEN });
    useCleanup(() => other.close());
    sb.userConfig(ghConfig(other.url));
    await sb.via(['gh']);
    expect(other.state.listCalls).toBe(1);
    expect(srv.state.listCalls).toBe(1);
  });

  it('ignores a corrupt cache file', async () => {
    const { srv, sb } = await setup();
    await sb.via(['gh']);
    const dir = join(sb.cacheDir, 'catalog');
    for (const name of readdirSync(dir)) writeFileSync(join(dir, name), '{not json');
    const r = await sb.via(['gh']);
    expect(r.code).toBe(0);
    expect(srv.state.listCalls).toBe(2);
  });

  it('still works when the cache cannot be written', async () => {
    const { sb } = await setup();
    sb.write('home/.cache', 'a file where the cache directory should be');
    const r = await sb.via(['gh', 'whoami']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('authorization: Bearer ***\n');
  });

  // Probing the protocol version starts a stdio server twice (the SDK probes a copy), so the very first
  // connection of a server with no cached catalog may spawn two processes.
  it('does not start a stdio server again to browse a cached catalog', async () => {
    const sb = makeSandbox();
    const log = sb.write('spawns.log', '');
    sb.userConfig(`sources: false\nservers:\n  job:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(CLI_STDIO_SERVER)}]\n    env: { CLI_FIXTURE_LOG: ${JSON.stringify(log)} }\n`);
    const spawns = (): number => readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
    expect((await sb.via(['job'])).code).toBe(0);
    const first = spawns();
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThanOrEqual(2);
    await sb.via(['job', 'issue']);
    await sb.via([]);
    await sb.via(['find', 'issue']);
    expect(spawns()).toBe(first);
    await sb.via(['sync']);
    expect(spawns()).toBeGreaterThan(first);
  });

  // The cache remembers the protocol the server spoke; a server of the old protocol is then connected
  // with the plain handshake, one process, no probe (a server of the stateless one is probed each time).
  it.runIf(defaultGeneration() === 'legacy')('starts a stdio server of the old protocol once when its catalog is cached', async () => {
    const sb = makeSandbox();
    const log = sb.write('spawns.log', '');
    sb.userConfig(`sources: false\nservers:\n  job:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(CLI_STDIO_SERVER)}]\n    env: { CLI_FIXTURE_LOG: ${JSON.stringify(log)} }\n`);
    const spawns = (): number => readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
    expect((await sb.via(['job'])).code).toBe(0);
    const first = spawns();
    await sb.via(['sync']);
    expect(spawns()).toBe(first + 1);
    await sb.via(['job', 'echo-text', '--message', 'x']);
    expect(spawns()).toBe(first + 2);
  });
});

describe('the cache hint of a stateless server', () => {
  async function hinted(ttlMs: number | undefined) {
    const srv = await startFixtureServer({ token: FAKE_TOKEN, protocol: 'modern', ...(ttlMs !== undefined ? { ttlMs } : {}) });
    useCleanup(() => srv.close());
    const sb = makeSandbox();
    sb.userConfig(ghConfig(srv.url));
    return { srv, sb };
  }

  it('shortens the 24 hours: the catalog is fetched again once the hint has run out', async () => {
    const { srv, sb } = await hinted(60_000);
    await sb.via(['gh'], { now: T0 });
    await sb.via(['gh'], { now: T0 + 59_000 });
    expect(srv.state.listCalls).toBe(1);
    await sb.via(['gh'], { now: T0 + 61_000 });
    expect(srv.state.listCalls).toBe(2);
  });

  it('does not lengthen it', async () => {
    const { srv, sb } = await hinted(10 * CATALOG_TTL_MS);
    await sb.via(['gh'], { now: T0 });
    await sb.via(['gh'], { now: T0 + CATALOG_TTL_MS + 1000 });
    expect(srv.state.listCalls).toBe(2);
  });

  it.each([0, undefined])('is no hint at all when it is %s: the 24 hours stay', async (ttl) => {
    const { srv, sb } = await hinted(ttl);
    await sb.via(['gh'], { now: T0 });
    await sb.via(['gh'], { now: T0 + 3600_000 });
    expect(srv.state.listCalls).toBe(1);
  });
});

describe('schema staleness (arguments.md, "schema 不可靠时")', () => {
  const LIST = ['gh', 'issue:list', '--owner', 'a', '--repo', 'b', '--state', 'merged'];

  function widenStateEnum(tools: Array<Record<string, any>>): void {
    const list = tools.find((t) => t.name === 'issue_list')!;
    list.inputSchema.properties.state.enum = ['open', 'closed', 'merged'];
  }

  it('refreshes a schema cached for more than five minutes when validation fails, then retries', async () => {
    const { srv, sb } = await setup();
    await sb.via(['gh'], { now: T0 });
    widenStateEnum(srv.state.tools);
    const r = await sb.via(LIST, { now: T0 + 10 * 60 * 1000 });
    expect(r.code).toBe(0);
    expect(srv.state.listCalls).toBe(2);
    expect(srv.state.calls).toEqual([{ name: 'issue_list', args: { owner: 'a', repo: 'b', state: 'merged' } }]);
    // The refreshed list is cached: the next command does not list again.
    await sb.via(LIST, { now: T0 + 10 * 60 * 1000 + 1000 });
    expect(srv.state.listCalls).toBe(2);
  });

  it('does not refresh a younger cache; the validation error stands', async () => {
    const { srv, sb } = await setup();
    await sb.via(['gh'], { now: T0 });
    widenStateEnum(srv.state.tools);
    const r = await sb.via(LIST, { now: T0 + 60 * 1000 });
    expect(r.code).toBe(2);
    expect(srv.state.listCalls).toBe(1);
    expect(srv.state.calls).toHaveLength(0);
  });

  it('refreshes only once: if the schema did not change the original error is reported', async () => {
    const { srv, sb } = await setup();
    await sb.via(['gh'], { now: T0 });
    const r = await sb.via(LIST, { now: T0 + 10 * 60 * 1000 });
    expect(r.code).toBe(2);
    expect(srv.state.listCalls).toBe(2);
    expect(srv.state.calls).toHaveLength(0);
  });
});

describe('cacheKey', () => {
  const base = (): ServerConfig => httpServer('https://mcp.example.com/mcp', { auth: { type: 'bearer', bearer: 'env:A_KEY' }, headers: { 'X-Team': 'plain' } });

  it('is stable and ignores everything that does not change the tool list', () => {
    expect(cacheKey(base())).toBe(cacheKey(base()));
    const tuned = { ...base(), timeout: 5, concurrency: 1, confirm: 'never' as const };
    expect(cacheKey(tuned)).toBe(cacheKey(base()));
  });

  it('changes with the transport definition and the credential reference', () => {
    const key = cacheKey(base());
    expect(cacheKey(httpServer('https://mcp.example.com/other', { auth: { type: 'bearer', bearer: 'env:A_KEY' }, headers: { 'X-Team': 'plain' } }))).not.toBe(key);
    expect(cacheKey({ ...base(), auth: { type: 'bearer', bearer: 'env:B_KEY' } })).not.toBe(key);
    expect(cacheKey({ ...base(), auth: { type: 'none' } })).not.toBe(key);
    expect(cacheKey(stdioServer({ args: ['a.js'] }))).not.toBe(cacheKey(stdioServer({ args: ['b.js'] })));
    expect(cacheKey(stdioServer({ env: { TOKEN: 'env:T' } }))).not.toBe(cacheKey(stdioServer({ env: { TOKEN: 'env:U' } })));
  });

  it('depends on literal env and header values (same command and names, different values: two files)', () => {
    const a = httpServer('https://x.example/mcp', { headers: { 'X-Team': 'one' } });
    const b = httpServer('https://x.example/mcp', { headers: { 'X-Team': 'two' } });
    expect(cacheKey(a)).not.toBe(cacheKey(b));
    const gh = stdioServer({ env: { CLI_FIXTURE_FEATURES: 'resources,prompts' } });
    const el = stdioServer({ env: { CLI_FIXTURE_FEATURES: 'elicit' } });
    expect(cacheKey(gh)).not.toBe(cacheKey(el));
    expect(cacheKey(gh)).toBe(cacheKey(stdioServer({ env: { CLI_FIXTURE_FEATURES: 'resources,prompts' } })));
  });

  it('does not hold a literal value in the key or look a credential reference up', () => {
    const key = cacheKey(stdioServer({ env: { MODE: 'super-secret-literal' } }));
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).not.toContain('super-secret');
    // A reference contributes its text only: the value it points to may change without moving the key.
    const saved = process.env.VIA_TEST_REF_VALUE;
    process.env.VIA_TEST_REF_VALUE = 'one';
    const before = cacheKey(stdioServer({ env: { TOKEN: 'env:VIA_TEST_REF_VALUE' } }));
    process.env.VIA_TEST_REF_VALUE = 'two';
    const after = cacheKey(stdioServer({ env: { TOKEN: 'env:VIA_TEST_REF_VALUE' } }));
    if (saved === undefined) delete process.env.VIA_TEST_REF_VALUE;
    else process.env.VIA_TEST_REF_VALUE = saved;
    expect(after).toBe(before);
  });

  it('keeps one raw list, one info file and one prebuilt file per distinct definition', () => {
    const dir = mkdtempSync(join(tmpdir(), 'via-key-'));
    try {
      const cache = new CatalogCache(dir);
      const a = stdioServer({ env: { MODE: 'a' } });
      const b = stdioServer({ env: { MODE: 'b' } });
      cache.write(a, [{ name: 'only_a', inputSchema: { type: 'object' } }], { fetchedAt: Date.now() });
      cache.write(b, [{ name: 'only_b', inputSchema: { type: 'object' } }], { fetchedAt: Date.now() });
      expect(readdirSync(dir).filter((n) => n.endsWith('.json'))).toHaveLength(2);
      expect(cache.read(a)?.tools.map((t) => t.name)).toEqual(['only_a']);
      expect(cache.read(b)?.tools.map((t) => t.name)).toEqual(['only_b']);
      cache.clear(a);
      expect(cache.read(a)).toBeUndefined();
      expect(cache.read(b)).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
