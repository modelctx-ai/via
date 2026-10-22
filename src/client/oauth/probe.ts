// The unauthenticated request that tells how a server wants to be authorized (RFC 9728 / RFC 6750), shared by the
// login and by the client-credentials grant.
import pkg from '../../../package.json';
import { MODERN_PROTOCOL_VERSIONS } from '../../protocol-versions';
import type { FetchLike } from '@modelcontextprotocol/client';

/** What an unauthenticated request to the server says about how to authorize (RFC 9728 / 6750). */
export async function probeChallenge(url: string, fetchFn: FetchLike | undefined): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
  try {
    const sdk = await import('@modelcontextprotocol/client');
    const send = fetchFn ?? ((u, init) => fetch(u, init));
    const clientInfo = { name: 'via', version: pkg.version };
    // One request per protocol generation, newest first: a server answers either with the challenge
    // (an unauthenticated request is refused before it is understood) or with "not for me", and the
    // second try covers a server that only understands the other generation. The versions are the
    // SDK's and via's own list (protocol-versions.ts), never a literal here.
    const modern = MODERN_PROTOCOL_VERSIONS[0]!;
    const probes: Array<{ headers: Record<string, string>; body: unknown }> = [
      {
        headers: { 'mcp-protocol-version': modern, 'mcp-method': 'server/discover' },
        body: {
          jsonrpc: '2.0',
          id: 0,
          method: 'server/discover',
          params: { _meta: { [sdk.PROTOCOL_VERSION_META_KEY]: modern, [sdk.CLIENT_INFO_META_KEY]: clientInfo, [sdk.CLIENT_CAPABILITIES_META_KEY]: {} } },
        },
      },
      {
        headers: {},
        body: { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: sdk.LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo } },
      },
    ];
    for (const probe of probes) {
      const response = await send(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...probe.headers },
        body: JSON.stringify(probe.body),
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) return sdk.extractWWWAuthenticateParams(response);
    }
    return {};
  } catch {
    return {}; // discovery by well-known paths still works without it
  }
}
