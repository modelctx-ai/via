// Mock MCP server used by the client tests (docs/development/testing.md, "模拟 server").
// Plain ESM so that `node test/fixtures/mcp/stdio-server.mjs` runs without a build step.
import { existsSync, writeFileSync } from 'node:fs';
import { buildServer } from './flavors.mjs';

const object = (properties = {}, required = []) => ({ type: 'object', properties, required });

export const TOOLS = [
  { name: 'echo', description: 'Echo a message', inputSchema: object({ message: { type: 'string' } }, ['message']) },
  { name: 'fail', description: 'Always returns isError', inputSchema: object() },
  { name: 'structured', description: 'Returns structuredContent', inputSchema: object() },
  {
    name: 'typed_text',
    description: 'Declares an outputSchema but answers with text only',
    inputSchema: object(),
    outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
  },
  {
    name: 'typed_wrong',
    description: 'Declares an outputSchema and answers with structuredContent that breaks it',
    inputSchema: object(),
    outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
  },
  { name: 'slow', description: 'Answers after ms milliseconds', inputSchema: object({ ms: { type: 'number' } }) },
  { name: 'read_env', description: 'Reads a variable from the server environment', inputSchema: object({ name: { type: 'string' } }, ['name']) },
  { name: 'busy', description: 'Holds a slot for 100 ms, tracking concurrency', inputSchema: object() },
  { name: 'max_busy', description: 'Highest number of overlapping busy calls so far', inputSchema: object() },
  { name: 'crash_once', description: 'Exits the first time (marker file in MOCK_MARKER), answers afterwards', inputSchema: object() },
  { name: 'pid', description: 'Process id of the server', inputSchema: object() },
  { name: 'regional', description: 'Echoes the region it was called with; declares x-mcp-header on region', inputSchema: object({ region: { type: 'string', 'x-mcp-header': 'Region' } }, ['region']) },
  { name: 'add_tool', description: 'Adds a tool to the list and sends notifications/tools/list_changed', inputSchema: object() },
];

/** Shared counters (the HTTP fixture builds one Server per request, so state lives outside). */
export function createState() {
  return { active: 0, maxActive: 0, extra: [] };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value) => ({ content: [{ type: 'text', text: String(value) }] });

/**
 * @param {{ pageSize?: number, state?: ReturnType<typeof createState>, flavor?: 'legacy' | 'modern', notifier?: { toolsChanged(): void }, ttlMs?: number }} [options]
 *   `ttlMs` is the freshness hint `tools/list` carries on the stateless protocol.
 *   `flavor` picks the protocol generation of the server (flavors.mjs); `notifier` is the stateless handler's change publisher.
 */
export function createMockServer({ pageSize = 0, state = createState(), flavor = 'legacy', notifier, ttlMs } = {}) {
  const table = {
    'tools/list': async (params) => {
      const all = [...TOOLS, ...state.extra];
      const hint = flavor === 'modern' && ttlMs !== undefined ? { ttlMs } : {};
      if (!pageSize) return { tools: all, ...hint };
      const start = params.cursor ? Number(params.cursor) : 0;
      const end = start + pageSize;
      return { tools: all.slice(start, end), ...(end < all.length ? { nextCursor: String(end) } : {}), ...hint };
    },
    'tools/call': async (params, h) => {
      const { name, arguments: args = {} } = params;
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
        case 'typed_text':
          return text('count: 3');
        case 'typed_wrong':
          return { content: [{ type: 'text', text: '{"count":"three"}' }], structuredContent: { count: 'three' } };
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
        case 'regional':
          // What a server that enforces SEP-2243 does: the argument must also arrive as a header (-32020 otherwise).
          if (flavor === 'modern' && h.header('mcp-param-region') === undefined) h.fail(-32020, 'Mcp-Param-Region header is required');
          return text(`region: ${args.region}`);
        case 'add_tool': {
          const added = `extra_${state.extra.length + 1}`;
          state.extra.push({ name: added, description: 'Added at runtime', inputSchema: object() });
          await h.toolsChanged();
          return text(added);
        }
        default:
          throw new Error(`unknown tool: ${name}`);
      }
    },
  };
  return buildServer(flavor, { name: 'mock', version: '0.0.0' }, { tools: { listChanged: true } }, table, notifier ? { notifier } : {});
}
