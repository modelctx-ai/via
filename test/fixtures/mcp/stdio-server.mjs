// Mock MCP server over stdio: `node test/fixtures/mcp/stdio-server.mjs`.
// MOCK_PAGE_SIZE paginates tools/list. MOCK_PROTOCOL=modern serves the stateless `2026-07-28` protocol
// (and, like any server built on the 2.x SDK's `serveStdio`, still the old handshake to a client that opens with it);
// MOCK_PROTOCOL=legacy-only (or unset) is a server of the old generation that has never heard of `server/discover`.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createMockServer, createState } from './mock-server.mjs';

const pageSize = Number(process.env.MOCK_PAGE_SIZE ?? 0);
if (process.env.MOCK_PROTOCOL === 'modern') {
  const state = createState();
  const ttlMs = process.env.MOCK_TTL_MS ? Number(process.env.MOCK_TTL_MS) : undefined;
  serveStdio(() => createMockServer({ pageSize, state, flavor: 'modern', ...(ttlMs !== undefined ? { ttlMs } : {}) }));
} else {
  const server = createMockServer({ pageSize });
  await server.connect(new StdioServerTransport());
}
