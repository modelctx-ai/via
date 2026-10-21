// The stateless protocol (`2026-07-28`) on a Node HTTP server, for the fixture servers: a fresh server
// instance per request from `makeServer(notifier)` (so state lives outside it, as in the legacy
// fixtures), served by the 2.x SDK's `createMcpHandler`. `legacy: 'reject'` makes the endpoint strict: a
// client that falls back to `initialize` is told the version is unsupported, so a test cannot pass by
// accident on the old protocol. Plain ESM like the other fixtures.
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

/**
 * @param {(notifier: { toolsChanged(): void }) => import('@modelcontextprotocol/server').Server} makeServer
 * @param {{ legacy?: 'reject' | 'stateless' }} [options]
 * @returns {{ handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>, notifier: { toolsChanged(): void }, close(): Promise<void> }}
 */
export function modernEndpoint(makeServer, { legacy = 'reject' } = {}) {
  const notifier = { toolsChanged: () => handler.notify.toolsChanged() };
  const handler = createMcpHandler(() => makeServer(notifier), { legacy });
  const node = toNodeHandler(handler);
  return { handle: (req, res) => node(req, res), notifier, close: () => handler.close() };
}
