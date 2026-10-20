// Mock MCP server used by the client tests (docs/development/testing.md, "模拟 server").
// Plain ESM so that `node test/fixtures/mcp/stdio-server.mjs` runs without a build step.
import { existsSync, writeFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const object = (properties = {}, required = []) => ({ type: 'object', properties, required });

export const TOOLS = [
  { name: 'echo', description: 'Echo a message', inputSchema: object({ message: { type: 'string' } }, ['message']) },
  { name: 'fail', description: 'Always returns isError', inputSchema: object() },
  { name: 'structured', description: 'Returns structuredContent', inputSchema: object() },
  { name: 'slow', description: 'Answers after ms milliseconds', inputSchema: object({ ms: { type: 'number' } }) },
  { name: 'read_env', description: 'Reads a variable from the server environment', inputSchema: object({ name: { type: 'string' } }, ['name']) },
  { name: 'busy', description: 'Holds a slot for 100 ms, tracking concurrency', inputSchema: object() },
  { name: 'max_busy', description: 'Highest number of overlapping busy calls so far', inputSchema: object() },
  { name: 'crash_once', description: 'Exits the first time (marker file in MOCK_MARKER), answers afterwards', inputSchema: object() },
  { name: 'pid', description: 'Process id of the server', inputSchema: object() },
  { name: 'add_tool', description: 'Adds a tool to the list and sends notifications/tools/list_changed', inputSchema: object() },
];

/** Shared counters (the HTTP fixture builds one Server per request, so state lives outside). */
export function createState() {
  return { active: 0, maxActive: 0, extra: [] };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value) => ({ content: [{ type: 'text', text: String(value) }] });

/**
 * @param {{ pageSize?: number, state?: ReturnType<typeof createState> }} [options]
 */
export function createMockServer({ pageSize = 0, state = createState() } = {}) {
  const server = new Server({ name: 'mock', version: '0.0.0' }, { capabilities: { tools: { listChanged: true } } });

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const all = [...TOOLS, ...state.extra];
    if (!pageSize) return { tools: all };
    const start = request.params?.cursor ? Number(request.params.cursor) : 0;
    const end = start + pageSize;
    return { tools: all.slice(start, end), ...(end < all.length ? { nextCursor: String(end) } : {}) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    switch (name) {
      case 'echo':
        return text(`echo: ${args.message}`);
      case 'fail':
        return { content: [{ type: 'text', text: 'boom' }], isError: true };
      case 'structured':
        return {
          content: [{ type: 'text', text: '{"items":[{"id":1},{"id":2}]}' }],
          structuredContent: { items: [{ id: 1 }, { id: 2 }] },
        };
      case 'slow':
        await sleep(Number(args.ms ?? 1000));
        return text('done');
      case 'read_env':
        return text(process.env[String(args.name)] ?? '<unset>');
      case 'busy': {
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        await sleep(100);
        state.active -= 1;
        return text('ok');
      }
      case 'max_busy':
        return text(state.maxActive);
      case 'crash_once': {
        const marker = process.env.MOCK_MARKER;
        if (marker && !existsSync(marker)) {
          writeFileSync(marker, 'crashed');
          process.exit(1);
        }
        return text('recovered');
      }
      case 'pid':
        return text(process.pid);
      case 'add_tool': {
        const name = `extra_${state.extra.length + 1}`;
        state.extra.push({ name, description: 'Added at runtime', inputSchema: object() });
        await server.sendToolListChanged();
        return text(name);
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  });

  return server;
}
