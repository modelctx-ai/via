// Mock MCP server for the CLI end-to-end tests: a small GitHub-shaped tool set with annotations,
// output schemas, progress, a long result and failing tools. Plain ESM like mock-server.mjs.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const object = (properties = {}, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });

/** The default tool list; tests may replace `state.tools` between runs (schema drift). */
export function defaultTools() {
  return [
    {
      name: 'issue_read',
      description: 'Get issue details',
      annotations: { readOnlyHint: true },
      inputSchema: object(
        { owner: str('Repository owner'), repo: str('Repository name'), issue_number: { type: 'number' }, method: { type: 'string', enum: ['get', 'get_comments'] } },
        ['owner', 'repo', 'issue_number', 'method'],
      ),
    },
    {
      name: 'issue_write',
      description: 'Create or update an issue',
      inputSchema: object({ owner: str('Repository owner'), repo: str('Repository name'), title: str('Title'), body: str('Body') }, ['owner', 'repo', 'title']),
    },
    {
      name: 'issue_list',
      description: 'List issues',
      annotations: { readOnlyHint: true },
      inputSchema: object(
        { owner: str('Repository owner'), repo: str('Repository name'), state: { type: 'string', enum: ['open', 'closed'] }, per_page: { type: 'integer', maximum: 100 } },
        ['owner', 'repo'],
      ),
    },
    {
      name: 'delete_file',
      description: 'Delete a file',
      annotations: { destructiveHint: true },
      inputSchema: object({ owner: str('Repository owner'), repo: str('Repository name'), path: str('File path') }, ['owner', 'repo', 'path']),
    },
    { name: 'search_code', description: 'Search code', annotations: { readOnlyHint: true }, inputSchema: object({ query: str('Search query') }, ['query']) },
    { name: 'list_pull_requests', description: 'List pull requests', annotations: { readOnlyHint: true }, inputSchema: object({ owner: str('Repository owner'), repo: str('Repository name') }, ['owner', 'repo']) },
    { name: 'request_copilot_review', description: 'Request a review', inputSchema: object({ pull_number: { type: 'number' } }, []) },
    { name: 'whoami', description: 'Show the credentials the server saw', inputSchema: object() },
    { name: 'echo_text', description: 'Echo a message', inputSchema: object({ message: str('Message') }, ['message']) },
    { name: 'run_job', description: 'A job that reports progress', inputSchema: object() },
    { name: 'sleepy', description: 'Answers after ms milliseconds', inputSchema: object({ ms: { type: 'number' } }) },
    { name: 'broken_tool', description: 'Always fails', inputSchema: object() },
    { name: 'picky_tool', description: 'Rejects its arguments server-side', inputSchema: object({ n: { type: 'number' } }) },
    {
      name: 'stats_get',
      description: 'Statistics',
      inputSchema: object(),
      outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
    },
  ];
}

/** Shared, inspectable state: one Server is built per HTTP request, so it lives outside. */
export function createCliState() {
  return { tools: defaultTools(), listCalls: 0, calls: [] };
}

/**
 * @param {{ state: ReturnType<typeof createCliState>, authorization?: string }} options
 */
export function createCliServer({ state, authorization }) {
  const server = new Server({ name: 'cli-fixture', version: '0.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    state.listCalls += 1;
    return { tools: state.tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    state.calls.push({ name, args });
    switch (name) {
      case 'issue_read':
        return { content: [{ type: 'text', text: JSON.stringify({ number: args.issue_number, title: 'Support OAuth DCR', state: 'open' }) }], structuredContent: { number: args.issue_number, title: 'Support OAuth DCR', state: 'open' } };
      case 'issue_write':
        return { content: [{ type: 'text', text: `created: ${args.title}` }] };
      case 'issue_list': {
        const items = [
          { number: 12, title: 'Support OAuth DCR', state: 'open' },
          { number: 11, title: 'Group inference too eager', state: 'open' },
          { number: 9, title: 'Windows named pipes', state: 'closed' },
        ];
        return { content: [{ type: 'text', text: JSON.stringify(items) }], structuredContent: { items } };
      }
      case 'list_pull_requests': {
        const rows = Array.from({ length: 300 }, (_, i) => ({ number: i + 1, title: `Pull request number ${i + 1}`, state: 'open' }));
        return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
      }
      case 'delete_file':
        return { content: [{ type: 'text', text: `deleted ${args.path}` }] };
      case 'search_code':
        return { content: [{ type: 'text', text: `results for ${args.query}` }] };
      case 'request_copilot_review':
        return { content: [{ type: 'text', text: 'requested' }] };
      case 'whoami':
        return { content: [{ type: 'text', text: `authorization: ${authorization ?? '<none>'}` }] };
      case 'echo_text':
        return { content: [{ type: 'text', text: `echo: ${args.message}` }] };
      case 'run_job': {
        const token = extra._meta?.progressToken;
        if (token !== undefined) {
          await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 2, message: 'halfway' } });
          // The SDK delivers notifications asynchronously: a response in the same read could overtake them.
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return { content: [{ type: 'text', text: 'job done' }] };
      }
      case 'sleepy':
        await new Promise((resolve) => setTimeout(resolve, Number(args.ms ?? 1000)));
        return { content: [{ type: 'text', text: 'rested' }] };
      case 'broken_tool':
        return { content: [{ type: 'text', text: 'boom: the upstream failed' }], isError: true };
      case 'picky_tool':
        return { content: [{ type: 'text', text: 'Invalid arguments: n must be even' }], isError: true };
      case 'stats_get':
        return { content: [{ type: 'text', text: '{"count":"many"}' }], structuredContent: { count: 'many' } };
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  });

  return server;
}
