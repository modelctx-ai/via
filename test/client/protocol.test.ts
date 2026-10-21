// Both protocol generations through the same client (docs/spec/daemon.md, "协议版本与无状态连接"): the
// connection tries the stateless protocol first (`server/discover`) and falls back to the `initialize`
// handshake, and everything above it (listing, calls, errors, cache hints, list changes) behaves the same.
import { afterEach, describe, expect, it } from 'vitest';
import { ClientError, McpSession } from '../../src/client';
import { TOOLS } from '../fixtures/mcp/mock-server.mjs';
import { FakeResolver, httpServer, startHttpServer, stdioServer, type Generation, type MockHttp } from '../helpers/client';

const sessions: McpSession[] = [];
const servers: MockHttp[] = [];

function session(server: ReturnType<typeof stdioServer>, options: ConstructorParameters<typeof McpSession>[2] = {}): McpSession {
  const s = new McpSession(server, new FakeResolver(), options);
  sessions.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const textOf = (result: { content?: Array<{ type: string; text?: string }> }): string | undefined => result.content?.[0]?.text;

async function waitUntil(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

const EXPECTED: Record<Generation, { version: string; stateful: { http: boolean; stdio: boolean } }> = {
  // The 1.x SDK server answers the highest revision it knows; an HTTP fixture without session ids is stateless in practice.
  legacy: { version: '2025-11-25', stateful: { http: false, stdio: true } },
  modern: { version: '2026-07-28', stateful: { http: false, stdio: false } },
};

describe.each(['legacy', 'modern'] as const)('%s server', (generation) => {
  const expected = EXPECTED[generation];

  describe.each(['http', 'stdio'] as const)('over %s', (transport) => {
    async function connect(options: { pageSize?: number } = {}): Promise<McpSession> {
      if (transport === 'stdio') {
        return session(stdioServer({ protocol: generation, ...(options.pageSize ? { env: { MOCK_PAGE_SIZE: String(options.pageSize) } } : {}) }));
      }
      const http = await startHttpServer({ protocol: generation, ...options });
      servers.push(http);
      return session(httpServer(http.url));
    }

    it('negotiates the newest version the server speaks and says whether the connection is stateful', async () => {
      const s = await connect();
      expect(s.protocol()).toBeUndefined();
      await s.listTools();
      expect(s.protocol()).toEqual({ version: expected.version, stateful: expected.stateful[transport] });
    });

    it('lists (across pages) and calls', async () => {
      const s = await connect({ pageSize: 3 });
      expect((await s.listTools()).map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
      expect(textOf(await s.callTool('echo', { message: 'hi' }))).toBe('echo: hi');
      const failed = await s.callTool('fail', undefined);
      expect(failed.isError).toBe(true);
      expect((await s.callTool('structured', undefined)).structuredContent).toEqual({ items: [{ id: 1 }, { id: 2 }] });
    });

    it('maps a failure of the server to exit 6 with its text', async () => {
      const s = await connect();
      await s.listTools();
      const err = (await s.callTool('no_such_tool', undefined).catch((e: unknown) => e)) as ClientError;
      expect(err).toBeInstanceOf(ClientError);
      expect(err).toMatchObject({ exitCode: 6, message: 'mock: unknown tool: no_such_tool' });
    });
  });
});

describe('the stateless protocol on the wire', () => {
  it('sends the method in an Mcp-Method header and the version in MCP-Protocol-Version, and no session id', async () => {
    const http = await startHttpServer({ protocol: 'modern' });
    servers.push(http);
    const s = session(httpServer(http.url));
    await s.listTools();
    await s.callTool('echo', { message: 'x' });
    expect(http.requests.length).toBeGreaterThanOrEqual(3); // the probe, the list, the call
    expect(http.requests[0]).toMatchObject({ 'mcp-method': 'server/discover', 'mcp-protocol-version': '2026-07-28' });
    const methods = http.requests.map((r) => r['mcp-method']);
    expect(methods).toContain('tools/list');
    expect(methods).toContain('tools/call');
    for (const headers of http.requests) {
      expect(headers['mcp-session-id']).toBeUndefined();
      expect(headers['mcp-protocol-version']).toBe('2026-07-28');
    }
    expect(methods).not.toContain('initialize');
  });

  it('falls back to the initialize handshake on a server of the old protocol, and sends nothing of the new one afterwards', async () => {
    const http = await startHttpServer({ protocol: 'legacy' });
    servers.push(http);
    const s = session(httpServer(http.url));
    await s.listTools();
    expect(s.protocol()).toMatchObject({ version: '2025-11-25' });
    const methods = http.requests.map((r) => r['mcp-method']);
    expect(methods.every((m) => m === undefined || m === 'server/discover')).toBe(true);
  });

  it('does not terminate a session on close: there is none', async () => {
    const http = await startHttpServer({ protocol: 'modern' });
    servers.push(http);
    const s = session(httpServer(http.url));
    await s.listTools();
    const before = http.requests.length;
    await s.close();
    expect(http.requests.length).toBe(before);
  });
});

describe('the cache hint of a stateless server', () => {
  it('is reported for a positive ttlMs and not for 0 or none', async () => {
    for (const [ttlMs, expected] of [[30_000, 30_000], [0, undefined], [undefined, undefined]] as const) {
      const http = await startHttpServer({ protocol: 'modern', ...(ttlMs !== undefined ? { ttlMs } : {}) });
      servers.push(http);
      const s = session(httpServer(http.url));
      let seen: number | undefined;
      await s.listTools({ onTtl: (ms) => void (seen = ms) });
      expect(seen, `ttlMs ${String(ttlMs)}`).toBe(expected);
    }
  });
});

describe('list changes', () => {
  it('reach the session as events on the subscription stream of the stateless protocol', async () => {
    const http = await startHttpServer({ protocol: 'modern' });
    servers.push(http);
    let changed = 0;
    const s = session(httpServer(http.url), { onToolsChanged: () => void (changed += 1) });
    await s.listTools();
    http.notifyToolsChanged();
    await waitUntil(() => changed > 0);
    expect(changed).toBe(1);
  });

  it('open the stream again when it drops, and report that events may have been missed', async () => {
    const http = await startHttpServer({ protocol: 'modern' });
    servers.push(http);
    let changed = 0;
    const s = session(httpServer(http.url), { onToolsChanged: () => void (changed += 1) });
    await s.listTools();
    http.dropConnections();
    await waitUntil(() => changed > 0, 8000); // the first retry comes after 1 s
    expect(changed).toBeGreaterThan(0);
    const before = changed;
    http.notifyToolsChanged();
    await waitUntil(() => changed > before);
    expect(changed).toBeGreaterThan(before);
  }, 20_000);

  it('arrive from a stateless stdio server too', async () => {
    let changed = 0;
    const s = session(stdioServer({ protocol: 'modern' }), { onToolsChanged: () => void (changed += 1) });
    await s.callTool('echo', { message: 'warm' });
    await s.callTool('add_tool', undefined);
    await waitUntil(() => changed > 0);
    expect(changed).toBeGreaterThan(0);
    expect((await s.listTools()).map((t) => t.name)).toContain('extra_1');
  });

  it('arrive as notifications from a server of the old protocol, as before', async () => {
    let changed = 0;
    const s = session(stdioServer({ protocol: 'legacy' }), { onToolsChanged: () => void (changed += 1) });
    await s.callTool('echo', { message: 'warm' });
    await s.callTool('add_tool', undefined);
    await waitUntil(() => changed > 0);
    expect(changed).toBe(1);
  });
});

describe('a server that speaks neither protocol', () => {
  it('fails to connect with exit 6 and says which server', async () => {
    const http = await startHttpServer({ status: 502 });
    servers.push(http);
    const s = session(httpServer(http.url));
    const err = await s.listTools().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClientError);
    expect((err as ClientError).exitCode).toBe(6);
  });
});

describe('a pinned protocol version', () => {
  const pinned = (url: string, version: string) => httpServer(url, { protocolVersion: version });

  it.each([
    ['modern', '2026-07-28'],
    ['legacy', '2025-11-25'],
    ['legacy', '2025-03-26'],
    ['legacy', '2024-11-05'],
  ] as const)('is used when a %s server supports %s', async (generation, version) => {
    const http = await startHttpServer({ protocol: generation });
    servers.push(http);
    const s = session(pinned(http.url, version));
    await s.listTools();
    expect(s.protocol()?.version).toBe(version);
  });

  it.each([
    ['legacy', '2026-07-28', ''],
    ['modern', '2025-11-25', ' (it supports 2026-07-28)'],
    ['modern', '2024-11-05', ' (it supports 2026-07-28)'],
  ] as const)('is an error, not a fallback, when a %s server does not support %s', async (generation, version, offered) => {
    const http = await startHttpServer({ protocol: generation });
    servers.push(http);
    const s = session(pinned(http.url, version));
    const err = (await s.listTools().catch((e: unknown) => e)) as ClientError;
    expect(err).toBeInstanceOf(ClientError);
    expect(err.info).toEqual({
      exitCode: 6,
      message: `cannot start mock: it does not support protocol version ${version}${offered}; servers.mock.protocolVersion pins it`,
      next: 'remove protocolVersion from servers.mock, or pin a version the server supports',
    });
  });

  it('applies to a stdio server too, and skips the probe for an old version', async () => {
    const old = session(stdioServer({ protocol: 'legacy', protocolVersion: '2025-06-18' }));
    await old.listTools();
    expect(old.protocol()).toEqual({ version: '2025-06-18', stateful: true });
    const refused = session(stdioServer({ protocol: 'legacy', protocolVersion: '2026-07-28' }));
    const err = (await refused.listTools().catch((e: unknown) => e)) as ClientError;
    expect(err).toBeInstanceOf(ClientError);
    expect(err.message).toBe('cannot start mock: it does not support protocol version 2026-07-28; servers.mock.protocolVersion pins it');
  });
});

describe('tool arguments mirrored into headers (x-mcp-header, stateless protocol)', () => {
  it('are sent as Mcp-Param-* headers, also when via listed the tools itself and the SDK holds no definitions', async () => {
    const http = await startHttpServer({ protocol: 'modern' });
    servers.push(http);
    const s = session(httpServer(http.url));
    await s.listTools();
    expect(textOf(await s.callTool('regional', { region: 'eu-west-1' }))).toBe('region: eu-west-1');
    const calls = http.requests.filter((r) => r['mcp-method'] === 'tools/call');
    expect(calls.at(-1)?.['mcp-param-region']).toBe('eu-west-1');
  });
});
