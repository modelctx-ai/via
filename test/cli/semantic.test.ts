import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startEmbeddingsServer, type EmbeddingsServer } from '../helpers/embeddings-server';
import { ghConfig, makeSandbox, startFixtureServer, useCleanup } from './helpers';

// `via find` with optional embedding retrieval (discovery.md, "语义检索"; security.md): a local
// OpenAI-compatible server answers with deterministic fake vectors.

const EMB_KEY = 'fake-embeddings-key-for-cli-tests-0001';

async function setup(embeddings: Parameters<typeof startEmbeddingsServer>[0] = {}) {
  const srv = await startFixtureServer();
  useCleanup(() => srv.close());
  const emb: EmbeddingsServer = await startEmbeddingsServer({ concepts: { zorp: 'echo' }, ...embeddings });
  useCleanup(() => emb.close());
  const sb = makeSandbox({ GH_TOKEN: 'fake-gh-token-for-cli-tests-0001', EMB_KEY });
  const semantic = (extra = '', url = emb.url) =>
    `${ghConfig(srv.url)}search:\n  semantic:\n    url: ${url}\n    model: fake-embed\n    auth: { bearer: "env:EMB_KEY" }\n${extra}`;
  return { srv, emb, sb, semantic };
}

const firstLine = (stdout: string) => stdout.trim().split('\n')[0] ?? '';

describe('via find with search.semantic', () => {
  it('finds a tool the words of the query do not name, and says what it embedded', async () => {
    const { sb, emb, semantic } = await setup();
    sb.userConfig(semantic());
    const r = await sb.via(['find', 'zorp']);
    expect(r.code).toBe(0);
    expect(firstLine(r.stdout)).toContain('echo');
    expect(r.stderr).toMatch(/^· semantic · embedded \d+ tools \(cached\)\n$/);
    expect(emb.requests.length).toBeGreaterThan(0);
  });

  it('is plain lexical search without the config entry', async () => {
    const { sb, emb, srv } = await setup();
    sb.userConfig(ghConfig(srv.url));
    const r = await sb.via(['find', 'zorp']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no tools match "zorp"');
    expect(emb.requests).toHaveLength(0);
  });

  it('caches tool embeddings: the second find only embeds the query and prints no note', async () => {
    const { sb, emb, semantic } = await setup();
    sb.userConfig(semantic());
    await sb.via(['find', 'zorp']);
    const embedded = emb.inputs();
    const second = await sb.via(['find', 'zorp again']);
    expect(second.code).toBe(0);
    expect(second.stderr).toBe('');
    expect(emb.inputs() - embedded).toBe(1);
    const files = readdirSync(join(sb.cacheDir, 'embeddings'));
    expect(files).toHaveLength(1);
  });

  it('sends the bearer token and never prints it, not even when the server echoes it back', async () => {
    const { sb, emb, semantic } = await setup({ token: 'a-different-key' });
    sb.userConfig(semantic());
    const r = await sb.via(['find', 'zorp']);
    expect(r.code).toBe(0);
    expect(emb.requests).toHaveLength(0); // rejected before being recorded
    expect(r.stderr).toBe('· semantic unavailable: authentication rejected (HTTP 401) · lexical results\n');
    expect(r.stdout + r.stderr).not.toContain(EMB_KEY);

    const ok = await setup({ token: EMB_KEY });
    ok.sb.userConfig(ok.semantic());
    const good = await ok.sb.via(['find', 'zorp']);
    expect(good.code).toBe(0);
    expect(ok.emb.requests.every((q) => q.headers.authorization === `Bearer ${EMB_KEY}`)).toBe(true);
    expect(good.stdout + good.stderr).not.toContain(EMB_KEY);
    const cached = readdirSync(join(ok.sb.cacheDir, 'embeddings')).map((f) => readFileSync(join(ok.sb.cacheDir, 'embeddings', f)).toString('latin1'));
    expect(cached.join('')).not.toContain(EMB_KEY);
  });

  it('reports a missing credential without a value and without calling the endpoint', async () => {
    const { sb, emb, semantic } = await setup();
    sb.userConfig(semantic());
    const r = await sb.via(['find', 'zorp'], { env: { EMB_KEY: undefined } });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/^· semantic unavailable: .*EMB_KEY.* · lexical results\n$/);
    expect(emb.requests).toHaveLength(0);
  });

  it('falls back to lexical results within the timeout when the endpoint is slow', async () => {
    const { sb, semantic } = await setup({ delayMs: 1500 });
    sb.userConfig(semantic('    timeout: 0.2\n    indexTimeout: 0.3\n'));
    const started = Date.now();
    const r = await sb.via(['find', 'issue']);
    expect(Date.now() - started).toBeLessThan(1400);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('gh issue:read');
    expect(r.stderr).toMatch(/^· semantic unavailable: timeout after 0\.3s · lexical results\n$/);
  });

  it('falls back when the endpoint is down', async () => {
    const { sb, emb, semantic } = await setup();
    const url = emb.url;
    await emb.close();
    sb.userConfig(semantic('', url));
    const r = await sb.via(['find', 'issue']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('gh issue:read');
    expect(r.stderr).toBe('· semantic unavailable: request failed (ECONNREFUSED) · lexical results\n');
  });

  it('does not touch the endpoint for an empty query or for any other command', async () => {
    const { sb, emb, semantic } = await setup();
    sb.userConfig(semantic());
    for (const argv of [['find'], ['find', ''], [], ['gh'], ['gh', 'issue'], ['servers'], ['sync']]) {
      const r = await sb.via(argv);
      expect(r.code, argv.join(' ')).toBe(0);
    }
    expect(emb.requests).toHaveLength(0);
  });

  it('ignores a project config that points find at another endpoint', async () => {
    const { sb, emb, srv } = await setup();
    sb.userConfig(ghConfig(srv.url));
    sb.projectConfig(`search:\n  semantic:\n    url: ${emb.url}\n    model: fake-embed\n`);
    const r = await sb.via(['find', 'zorp']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no tools match "zorp"');
    expect(emb.requests).toHaveLength(0);
  });

  it('rejects an insecure endpoint like any other invalid configuration', async () => {
    const { sb, srv } = await setup();
    sb.userConfig(`${ghConfig(srv.url)}search:\n  semantic: { url: "http://embeddings.example.invalid/v1", model: m }\n`);
    const r = await sb.via(['find', 'issue']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('search.semantic.url: expected https URL (http is accepted for localhost only)');
  });
});
