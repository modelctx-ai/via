// Mock MCP server for the CLI end-to-end tests: a small GitHub-shaped tool set with annotations,
// output schemas, progress, a long result and failing tools. Plain ESM like mock-server.mjs.
// With `features` it also serves resources (text, JSON, blob, several contents, a long text, templates,
// two list pages) and prompts; the feature `roots` adds the tool `list_roots`, which asks the client for its roots.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

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
    { name: 'sleepy', description: 'Answers after ms milliseconds', inputSchema: object({ ms: { type: 'number' }, label: str('Echoed back') }) },
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

const ROOTS_TOOL = { name: 'list_roots', description: 'Ask the client for its roots', inputSchema: object() };

/** A 1x1 PNG. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const RESOURCES = [
  { uri: 'file:///project/README.md', name: 'README.md', description: 'Project readme', mimeType: 'text/plain' },
  { uri: 'file:///project/data.json', name: 'data.json', mimeType: 'application/json' },
  { uri: 'file:///project/logo.png', name: 'logo.png', mimeType: 'image/png' },
  { uri: 'file:///project/credentials.txt', name: 'credentials.txt', description: 'Echoes the credential the server saw', mimeType: 'text/plain' },
  { uri: 'file:///project/big.txt', name: 'big.txt', description: 'A long text', mimeType: 'text/plain' },
  { uri: 'file:///project/dir', name: 'dir', description: 'Two files at once' },
];

const TEMPLATES = [{ uriTemplate: 'file:///project/logs/{date}.log', name: 'log', description: 'Log of a day', mimeType: 'text/plain' }];

const PROMPTS = [
  {
    name: 'review',
    description: 'Review a piece of code',
    arguments: [
      { name: 'code', description: 'The code to review', required: true },
      { name: 'lang', description: 'Programming language' },
    ],
  },
  { name: 'greet_user', description: 'Greet someone', arguments: [{ name: 'name', required: true }] },
  { name: 'summarize', description: 'A prompt with several messages' },
];

/** Shared, inspectable state: one Server is built per HTTP request, so it lives outside. */
export function createCliState() {
  return { tools: defaultTools(), listCalls: 0, calls: [], inflight: 0, maxInflight: 0, reads: [], prompts: [] };
}

/**
 * @param {{ state: ReturnType<typeof createCliState>, authorization?: string, features?: Array<'resources' | 'prompts' | 'roots'> }} options
 */
export function createCliServer({ state, authorization, features = [] }) {
  const capabilities = { tools: {}, ...(features.includes('resources') ? { resources: {} } : {}), ...(features.includes('prompts') ? { prompts: {} } : {}) };
  const server = new Server({ name: 'cli-fixture', version: '0.0.0' }, { capabilities });
  const secret = authorization ?? process.env.FIXTURE_SECRET ?? '<none>';

  if (features.includes('resources')) {
    // Two pages, to prove that the client follows `nextCursor`.
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      return request.params?.cursor === 'page-2' ? { resources: RESOURCES.slice(3) } : { resources: RESOURCES.slice(0, 3), nextCursor: 'page-2' };
    });
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: TEMPLATES }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      state.reads.push(uri);
      switch (uri) {
        case 'file:///project/README.md':
          return { contents: [{ uri, mimeType: 'text/plain', text: '# Project\nHello from the readme.' }] };
        case 'file:///project/data.json':
          return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ name: 'via', tags: ['a', 'b'], empty: null }) }] };
        case 'file:///project/logo.png':
          return { contents: [{ uri, mimeType: 'image/png', blob: PNG }] };
        case 'file:///project/credentials.txt':
          return { contents: [{ uri, mimeType: 'text/plain', text: `authorization: ${secret}` }] };
        case 'file:///project/big.txt':
          return { contents: [{ uri, mimeType: 'text/plain', text: Array.from({ length: 400 }, (_, i) => `line ${i + 1} of the long text`).join('\n') }] };
        case 'file:///project/dir':
          return { contents: [{ uri: 'file:///project/dir/a.txt', mimeType: 'text/plain', text: 'file a' }, { uri: 'file:///project/dir/b.bin', mimeType: 'application/octet-stream', blob: Buffer.from('bin').toString('base64') }] };
        case 'file:///project/logs/2026-10-20.log':
          return { contents: [{ uri, mimeType: 'text/plain', text: 'started\nstopped' }] };
        case 'file:///project/odd':
          throw new McpError(ErrorCode.InvalidParams, 'Invalid URI');
        default:
          throw new McpError(-32002, `Resource not found: ${uri}`);
      }
    });
  }

  if (features.includes('prompts')) {
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;
      state.prompts.push({ name, args });
      switch (name) {
        case 'review':
          if (args.code === undefined) throw new McpError(ErrorCode.InvalidParams, 'Missing required argument: code');
          return { description: 'Review', messages: [{ role: 'user', content: { type: 'text', text: `Please review this ${args.lang ?? 'code'}:\n${args.code}` } }] };
        case 'greet_user':
          return { messages: [{ role: 'user', content: { type: 'text', text: `Hello, ${args.name}!` } }] };
        case 'summarize':
          return {
            messages: [
              { role: 'user', content: { type: 'text', text: 'Summarize the readme.' } },
              { role: 'user', content: { type: 'resource', resource: { uri: 'file:///project/README.md', mimeType: 'text/plain', text: '# Project' } } },
              { role: 'assistant', content: { type: 'text', text: 'It is a project.' } },
            ],
          };
        default:
          throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
      }
    });
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    state.listCalls += 1;
    return { tools: features.includes('roots') ? [...state.tools, ROOTS_TOOL] : state.tools };
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
      case 'list_roots': {
        // A server asking its client: over stdio only (the HTTP fixture answers each request on a fresh server).
        const roots = server.getClientCapabilities()?.roots;
        if (!roots) return { content: [{ type: 'text', text: 'roots: the client did not declare the capability' }] };
        const listed = await server.listRoots();
        return { content: [{ type: 'text', text: [`roots (listChanged: ${roots.listChanged === true}):`, ...listed.roots.map((r) => `${r.uri} ${r.name ?? ''}`.trimEnd())].join('\n') }] };
      }
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
        // `maxInflight` is how many sleepy calls overlapped at the most: the concurrency tests read it.
        state.inflight += 1;
        state.maxInflight = Math.max(state.maxInflight, state.inflight);
        try {
          await new Promise((resolve) => setTimeout(resolve, Number(args.ms ?? 1000)));
        } finally {
          state.inflight -= 1;
        }
        return { content: [{ type: 'text', text: args.label === undefined ? 'rested' : `rested ${args.label}` }] };
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
