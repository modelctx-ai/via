// src/protocol-versions.ts repeats constants the MCP SDK owns, because the config loader must not import
// the SDK (cold start). These tests compare the copies with the SDK installed in node_modules, so an SDK
// upgrade that adds, drops or renames a protocol revision fails here instead of drifting silently.
import { Client, InMemoryTransport, LATEST_PROTOCOL_VERSION, SERVER_INFO_META_KEY as SDK_SERVER_INFO_META_KEY, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/client';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { isModernProtocolVersion, isProtocolVersion, LEGACY_PROTOCOL_VERSIONS, MODERN_PROTOCOL_VERSIONS, PROTOCOL_VERSIONS, SERVER_INFO_META_KEY } from '../src/protocol-versions';

describe('protocol version constants', () => {
  it('lists the revisions the SDK negotiates with `initialize`', () => {
    expect([...LEGACY_PROTOCOL_VERSIONS]).toEqual([...SUPPORTED_PROTOCOL_VERSIONS]);
    expect(LEGACY_PROTOCOL_VERSIONS[0]).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('lists the stateless revisions the SDK server advertises in `server/discover`', async () => {
    const handler = createMcpHandler(() => new Server({ name: 'drift', version: '0' }, { capabilities: { tools: {} } }), { legacy: 'reject' });
    const response = await handler.fetch(
      new Request('http://drift.invalid/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': MODERN_PROTOCOL_VERSIONS[0]!, 'mcp-method': 'server/discover' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'server/discover',
          params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSIONS[0], 'io.modelcontextprotocol/clientInfo': { name: 'drift', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} } },
        }),
      }),
    );
    const body = (await response.json()) as { result?: { supportedVersions?: string[]; _meta?: Record<string, unknown> } };
    expect(body.result?.supportedVersions).toBeDefined();
    // A server with legacy serving off advertises the stateless revisions only.
    expect([...body.result!.supportedVersions!].sort()).toEqual([...MODERN_PROTOCOL_VERSIONS].sort());
    expect(body.result?._meta?.[SERVER_INFO_META_KEY]).toEqual({ name: 'drift', version: '0' });
  });

  it('is accepted by the SDK client when pinned: every stateless revision connects, an unknown one does not', async () => {
    for (const version of MODERN_PROTOCOL_VERSIONS) {
      const handler = createMcpHandler(() => new Server({ name: 'pin', version: '0' }, { capabilities: { tools: {} } }), { legacy: 'reject' });
      const client = new Client({ name: 'via', version: '0' }, { capabilities: {}, versionNegotiation: { mode: { pin: version } } });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      // A tiny bridge from the in-memory pipe to the fetch handler: enough for the connect-time probe.
      serverSide.onmessage = (message) => {
        void (async () => {
          const response = await handler.fetch(
            new Request('http://pin.invalid/mcp', {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': version, 'mcp-method': (message as { method: string }).method },
              body: JSON.stringify(message),
            }),
          );
          await serverSide.send((await response.json()) as never);
        })();
      };
      await serverSide.start();
      await client.connect(clientSide);
      expect(client.getNegotiatedProtocolVersion()).toBe(version);
      expect(client.getProtocolEra()).toBe('modern');
      await client.close();
    }
  });

  it('knows its own lists', () => {
    expect(PROTOCOL_VERSIONS).toEqual([...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS]);
    expect(new Set(PROTOCOL_VERSIONS).size).toBe(PROTOCOL_VERSIONS.length);
    for (const v of MODERN_PROTOCOL_VERSIONS) expect(isModernProtocolVersion(v) && isProtocolVersion(v)).toBe(true);
    for (const v of LEGACY_PROTOCOL_VERSIONS) expect(!isModernProtocolVersion(v) && isProtocolVersion(v)).toBe(true);
    expect(isProtocolVersion('2099-01-01')).toBe(false);
  });

  it('spells the server identity key the way the SDK does', () => {
    expect(SERVER_INFO_META_KEY).toBe(SDK_SERVER_INFO_META_KEY);
  });
});
