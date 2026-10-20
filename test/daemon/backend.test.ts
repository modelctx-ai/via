// DaemonBackend.listing against a stand-in for the daemon: what it asks (`have`), and what it does
// with an "unchanged" answer. The real daemon's side of `have` is in protocol.test.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogCache } from '../../src/cli/catalog-cache';
import { DaemonBackend } from '../../src/daemon/backend';
import { daemonRuntime, type DaemonClient } from '../../src/daemon/client';
import type { ListResult, RequestBody } from '../../src/protocol';
import { httpServer } from '../helpers/client';
import { loadTools } from '../helpers/fixtures';

const T0 = 1_800_000_000_000;
const tools = loadTools('tools', 'github');
const server = httpServer('http://127.0.0.1:1/gh', { name: 'gh', provider: 'gh' });

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(answer: (request: RequestBody & { have?: number; refresh?: boolean }) => ListResult) {
  const dir = mkdtempSync(join(tmpdir(), 'via-db-'));
  dirs.push(dir);
  const cache = new CatalogCache(join(dir, 'catalog'), () => T0 + 1000);
  const requests: Array<RequestBody & { have?: number; refresh?: boolean }> = [];
  const client = {
    connection: async () => ({
      request: async (body: RequestBody & { have?: number; refresh?: boolean }) => {
        requests.push(body);
        return { id: '1', type: 'result', ok: true, result: answer(body), meta: { elapsedMs: 0 } };
      },
    }),
  } as unknown as DaemonClient;
  const backend = new DaemonBackend({ client, servers: [server], cwd: dir, env: {}, serverIdleTimeoutSec: 60, cache });
  return { backend, cache, requests };
}

describe('DaemonBackend.listing with `have`', () => {
  it('does not offer `have` when the cache file is not the list the caller built from', async () => {
    const { backend, cache, requests } = setup(() => ({ tools, fetchedAt: T0, fromCache: true }));
    // No file at all.
    await backend.listing(server, { timeoutMs: 1000, have: T0 });
    // A file of another age.
    cache.write(server, tools, { fetchedAt: T0 - 5 });
    await backend.listing(server, { timeoutMs: 1000, have: T0 });
    expect(requests.map((r) => r.have)).toEqual([undefined, undefined]);
  });

  it('offers `have` and reads the tools from the file when the daemon says nothing changed', async () => {
    const { backend, cache, requests } = setup((request) => (request.have === T0 ? { unchanged: true, fetchedAt: T0, fromCache: true } : { tools, fetchedAt: T0, fromCache: true }));
    const bytes = cache.write(server, tools, { fetchedAt: T0 });
    const listing = await backend.listing(server, { timeoutMs: 1000, have: T0 });
    expect(requests.map((r) => r.have)).toEqual([T0]);
    expect(listing).toMatchObject({ fetchedAt: T0, fromCache: true, rawBytes: bytes });
    expect(listing.tools.map((t) => t.name)).toEqual(tools.map((t) => t.name));
  });

  it('does not trust an "unchanged" about a list other than the one in the file: it asks for a refresh', async () => {
    const { backend, cache, requests } = setup((request) => (request.refresh ? { tools, fetchedAt: T0 + 7, fromCache: false } : { unchanged: true, fetchedAt: T0 + 7, fromCache: true }));
    cache.write(server, tools, { fetchedAt: T0 });
    const listing = await backend.listing(server, { timeoutMs: 1000, have: T0 });
    expect(requests.map((r) => [r.have, r.refresh])).toEqual([[T0, undefined], [undefined, true]]);
    expect(listing).toMatchObject({ fetchedAt: T0 + 7, fromCache: false });
    expect(listing.tools.length).toBe(tools.length);
  });

  it('tells the length of the cache file a full answer was written to, when the file is that list', async () => {
    const { backend, cache } = setup(() => ({ tools, fetchedAt: T0, fromCache: false }));
    const bytes = cache.write(server, tools, { fetchedAt: T0 });
    expect((await backend.listing(server, { timeoutMs: 1000 })).rawBytes).toBe(bytes);
    cache.write(server, tools, { fetchedAt: T0 + 1 });
    expect((await backend.listing(server, { timeoutMs: 1000 })).rawBytes).toBeUndefined();
  });

  it('never offers `have` for a refresh', async () => {
    const { backend, cache, requests } = setup(() => ({ tools, fetchedAt: T0, fromCache: false }));
    cache.write(server, tools, { fetchedAt: T0 });
    await backend.listing(server, { timeoutMs: 1000, refresh: true, have: T0 });
    expect(requests.map((r) => r.have)).toEqual([undefined]);
    expect(requests[0]!.refresh).toBe(true);
  });
});

describe('the runtime a daemon is started with', () => {
  it('caps the young generation and the malloc arenas for Node, and leaves other runtimes alone', () => {
    const node = daemonRuntime(process.execPath);
    expect(node.flags).toEqual(['--max-semi-space-size=2']);
    expect(node.env).toEqual(process.platform === 'linux' ? { MALLOC_ARENA_MAX: '2' } : {});
    expect(daemonRuntime('/usr/local/bin/via')).toEqual({ flags: [], env: {} });
    expect(daemonRuntime('bun')).toEqual({ flags: [], env: {} });
  });
});
