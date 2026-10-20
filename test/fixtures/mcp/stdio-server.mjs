// Mock MCP server over stdio: `node test/fixtures/mcp/stdio-server.mjs`.
// MOCK_PAGE_SIZE paginates tools/list.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMockServer } from './mock-server.mjs';

const server = createMockServer({ pageSize: Number(process.env.MOCK_PAGE_SIZE ?? 0) });
await server.connect(new StdioServerTransport());
