// Mock MCP server for the CLI end-to-end tests: a small GitHub-shaped tool set with annotations,
// output schemas, progress, a long result and failing tools. Plain ESM like mock-server.mjs.
// With `features` it also serves resources (text, JSON, blob, several contents, a long text, templates,
// two list pages) and prompts; the feature `roots` adds the tool `list_roots`, which asks the client for its roots.
import { createHash } from 'node:crypto';
import { buildServer } from './flavors.mjs';

const INVALID_PARAMS = -32602;

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

/** What `features: ['completions']` completes: prompt argument `lang`, and the `{date}` of the log template. */
const LANGS = ['python', 'pytorch', 'perl', 'rust', 'ruby', 'go'];
const DATES = ['2026-10-18', '2026-10-19', '2026-10-20'];

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

// Tasks ---------------------------------------------------------------------------------------------------------
// `report_job` takes `ms` (how long the job runs) and `mode`: `ok`, `fail`, `input` (waits for input for ever) or `stubborn`
// (does not stop when cancelled). The old generation (2025-11-25) makes a task when the client asks for one (`params.task`);
// the stateless generation (2026-07-28, the `io.modelcontextprotocol/tasks` extension) makes one when the client declared
// the extension and the job takes 100 ms or more. A task's status follows the clock.

const TASK_TOOLS = [
  { name: 'report_job', description: 'Builds a report (a long job)', execution: { taskSupport: 'optional' }, inputSchema: object({ ms: { type: 'number' }, mode: { type: 'string', enum: ['ok', 'fail', 'input', 'stubborn'] } }) },
  { name: 'must_task', description: 'Only runs as a task', execution: { taskSupport: 'required' }, inputSchema: object({ ms: { type: 'number' } }) },
];
const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
const taskStatus = (t, now = Date.now()) => (t.cancelled ? 'cancelled' : t.mode === 'input' ? 'input_required' : now - t.createdAt < t.ms ? 'working' : t.mode === 'fail' ? 'failed' : 'completed');
const taskResult = (t) => ({ content: [{ type: 'text', text: `report ready after ${t.ms}ms` }] });
const iso = (ms) => new Date(ms).toISOString();

// Skills (the extension is part of the stateless protocol: only the `modern` flavor serves them) ---------------------

const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const FORMS = 'Refund form fields:\n- order id\n- amount\n';
const SKILL_FILES = {
  'skill://refunds/SKILL.md': { mimeType: 'text/markdown', text: '---\nname: refunds\ndescription: Handle refund requests step by step.\n---\n# Refunds\nRead references/FORMS.md first.\n' },
  'skill://refunds/references/FORMS.md': { mimeType: 'text/markdown', text: FORMS },
  'skill://refunds/assets/pixel.png': { mimeType: 'image/png', blob: PNG },
  'skill://acme/billing/SKILL.md': { mimeType: 'text/markdown', text: '---\nname: billing\ndescription: Acme billing.\n---\nAcme billing steps.\n' },
  'skill://beta/billing/SKILL.md': { mimeType: 'text/markdown', text: '---\nname: billing\ndescription: Beta billing.\n---\nBeta billing steps.\n' },
  'skill://dyn/SKILL.md': { mimeType: 'text/markdown', text: '---\nname: dyn\ndescription: A skill without a manifest.\n---\nDynamic.\n' },
  'skill://tampered/SKILL.md': { mimeType: 'text/markdown', text: '---\nname: tampered\ndescription: Content differs from its manifest.\n---\nWhat the server really sends.\n' },
  'skill://short/SKILL.md': { mimeType: 'text/markdown', text: '---\nname: short\ndescription: Size differs from its manifest.\n---\nTruncated.\n' },
};
const bytesOf = (c) => (c.blob !== undefined ? Buffer.from(c.blob, 'base64') : Buffer.from(c.text, 'utf8'));
const fileEntry = (uri, override = {}) => ({ uri, digest: sha(bytesOf(SKILL_FILES[uri])), size: bytesOf(SKILL_FILES[uri]).length, ...override });
/** The skills the fixture publishes: `resources` is the manifest the extension requires. */
function skillEntries() {
  return [
    { uri: 'skill://refunds/SKILL.md', frontmatter: { name: 'refunds', description: 'Handle refund requests step by step.\nA second line that the list does not show.' }, resources: ['skill://refunds/SKILL.md', 'skill://refunds/references/FORMS.md', 'skill://refunds/assets/pixel.png'].map((u) => fileEntry(u)) },
    { uri: 'skill://acme/billing/SKILL.md', frontmatter: { name: 'billing', description: 'Acme billing.' }, resources: [fileEntry('skill://acme/billing/SKILL.md')] },
    { uri: 'skill://beta/billing/SKILL.md', frontmatter: { name: 'billing', description: 'Beta billing.' }, resources: [fileEntry('skill://beta/billing/SKILL.md')] },
    { uri: 'skill://dyn/SKILL.md', frontmatter: { name: 'dyn', description: 'A skill without a manifest.' }, resources: 'dynamic' },
    { uri: 'skill://tampered/SKILL.md', frontmatter: { name: 'tampered', description: 'Content differs from its manifest.' }, resources: [fileEntry('skill://tampered/SKILL.md', { digest: sha(Buffer.from('what the manifest promised')) })] },
    ...(SKILL_FILES['skill://echo/SKILL.md'] ? [{ uri: 'skill://echo/SKILL.md', frontmatter: { name: 'echo', description: 'Its text contains the credential the server saw.' }, resources: [fileEntry('skill://echo/SKILL.md')] }] : []),
    { uri: 'skill://short/SKILL.md', frontmatter: { name: 'short', description: 'Size differs from its manifest.' }, resources: [fileEntry('skill://short/SKILL.md', { size: 999 })] },
  ];
}

/** Shared, inspectable state: one Server is built per HTTP request, so it lives outside. */
export function createCliState() {
  return { tools: defaultTools(), listCalls: 0, calls: [], inflight: 0, maxInflight: 0, reads: [], prompts: [], promptList: undefined, completions: [], skillRequests: [], tasks: new Map(), taskRequests: [] };
}

/**
 * @param {{ state: ReturnType<typeof createCliState>, authorization?: string, features?: Array<'resources' | 'prompts' | 'roots' | 'completions' | 'skills' | 'tasks' | 'tasks-nolist'>, flavor?: 'legacy' | 'modern', notifier?: { toolsChanged(): void }, ttlMs?: number, about?: { description?: string, websiteUrl?: string, instructions?: string } }} options
 *   `flavor` picks the protocol generation (flavors.mjs); `notifier` is the stateless handler's change publisher;
 *   `about` is what the server says about itself (`serverInfo.description`, `websiteUrl`, `instructions`).
 */
export function createCliServer({ state, authorization, features = [], flavor = 'legacy', notifier, ttlMs, about = {} }) {
  const capabilities = {
    tools: {},
    ...(features.includes('resources') ? { resources: {} } : {}),
    ...(features.includes('prompts') ? { prompts: {} } : {}),
    ...(features.includes('completions') ? { completions: {} } : {}),
    ...(features.includes('tasks') || features.includes('tasks-nolist') ? (flavor === 'modern' ? {} : { tasks: { ...(features.includes('tasks') ? { list: {} } : {}), cancel: {}, requests: { tools: { call: {} } } } }) : {}),
    // The skills extension belongs to the stateless protocol; a server of the old generation has nothing to declare.
    ...(features.includes('skills') && flavor === 'modern' ? { resources: {} } : {}),
  };
  // Extensions exist on the stateless generation only (skills, tasks).
  const extensions = {
    ...(features.includes('skills') && flavor === 'modern' ? { 'io.modelcontextprotocol/skills': {} } : {}),
    ...((features.includes('tasks') || features.includes('tasks-nolist')) && flavor === 'modern' ? { [TASKS_EXTENSION]: {} } : {}),
  };
  if (Object.keys(extensions).length > 0) capabilities.extensions = extensions;
  const table = {};
  const secret = authorization ?? process.env.FIXTURE_SECRET ?? '<none>';

  if (features.includes('resources')) {
    // Two pages, to prove that the client follows `nextCursor`.
    table['resources/list'] = async (params) => {
      return params.cursor === 'page-2' ? { resources: RESOURCES.slice(3) } : { resources: RESOURCES.slice(0, 3), nextCursor: 'page-2' };
    };
    table['resources/templates/list'] = async () => ({ resourceTemplates: TEMPLATES });
    table['resources/read'] = async (params, h) => {
      const { uri } = params;
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
          h.fail(INVALID_PARAMS, 'Invalid URI');
        default:
          h.fail(-32002, `Resource not found: ${uri}`);
      }
    };
  }

  if (features.includes('prompts')) {
    table['prompts/list'] = async () => ({ prompts: state.promptList ?? PROMPTS });
    table['prompts/get'] = async (params, h) => {
      const { name, arguments: args = {} } = params;
      state.prompts.push({ name, args });
      switch (name) {
        case 'review':
          if (args.code === undefined) h.fail(INVALID_PARAMS, 'Missing required argument: code');
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
          h.fail(INVALID_PARAMS, `Unknown prompt: ${name}`);
      }
    };
  }

  const withTasks = features.includes('tasks') || features.includes('tasks-nolist');
  const unknownTask = (h, id) => h.fail(INVALID_PARAMS, `Failed to retrieve task: Task not found (${String(id).slice(0, 40)})`);
  const startTask = (name, args, wire) => {
    const t = { id: `job/${state.tasks.size + 1}`, tool: name, ms: Number(args.ms ?? 300), mode: args.mode ?? 'ok', createdAt: Date.now(), cancelled: false };
    state.tasks.set(t.id, t);
    state.taskRequests.push(`create ${t.id} ${wire}`);
    return t;
  };
  if (withTasks && flavor === 'legacy') {
    const wire = (t) => ({ taskId: t.id, status: taskStatus(t), createdAt: iso(t.createdAt), lastUpdatedAt: iso(Date.now()), ttl: 60000, pollInterval: 50, ...(taskStatus(t) === 'failed' ? { statusMessage: 'job failed' } : {}) });
    table['tasks/get'] = async (params, h) => {
      state.taskRequests.push(`get ${params.taskId}`);
      const t = state.tasks.get(params.taskId);
      return t ? wire(t) : unknownTask(h, params.taskId);
    };
    table['tasks/result'] = async (params, h) => {
      state.taskRequests.push(`result ${params.taskId}`);
      const t = state.tasks.get(params.taskId);
      if (!t) return unknownTask(h, params.taskId);
      for (let i = 0; i < 100 && taskStatus(t) === 'working'; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      const status = taskStatus(t);
      if (status === 'completed') return { ...taskResult(t), _meta: { 'io.modelcontextprotocol/related-task': { taskId: t.id } } };
      return h.fail(-32603, status === 'failed' ? 'job failed' : `task is ${status}`);
    };
    table['tasks/list'] = async () => {
      state.taskRequests.push('list');
      return { tasks: [...state.tasks.values()].map(wire) };
    };
    table['tasks/cancel'] = async (params, h) => {
      state.taskRequests.push(`cancel ${params.taskId}`);
      const t = state.tasks.get(params.taskId);
      if (!t) return unknownTask(h, params.taskId);
      if (['completed', 'failed', 'cancelled'].includes(taskStatus(t))) return h.fail(INVALID_PARAMS, `Cannot cancel task: already ${taskStatus(t)}`);
      if (t.mode !== 'stubborn') t.cancelled = true;
      return wire(t);
    };
  }
  if (withTasks && flavor === 'modern') {
    const base = (t) => ({ taskId: t.id, status: taskStatus(t), createdAt: iso(t.createdAt), lastUpdatedAt: iso(Date.now()), ttlMs: 60000, pollIntervalMs: 50 });
    table['tasks/get'] = async (params, h) => {
      state.taskRequests.push(`get ${params.taskId}`);
      const t = state.tasks.get(params.taskId);
      if (!t) return unknownTask(h, params.taskId);
      const status = taskStatus(t);
      return {
        ...base(t),
        ...(status === 'completed' ? { result: taskResult(t) } : {}),
        ...(status === 'failed' ? { error: { code: -32603, message: 'job failed' }, statusMessage: 'job failed' } : {}),
        ...(status === 'input_required' ? { inputRequests: { ask: { method: 'elicitation/create', params: { message: 'Which region?', mode: 'form', requestedSchema: { type: 'object', properties: {} } } } } } : {}),
      };
    };
    table['tasks/cancel'] = async (params, h) => {
      state.taskRequests.push(`cancel ${params.taskId}`);
      const t = state.tasks.get(params.taskId);
      if (!t) return unknownTask(h, params.taskId);
      if (t.mode !== 'stubborn' && ['working', 'input_required'].includes(taskStatus(t))) t.cancelled = true;
      return {};
    };
  }

  if (features.includes('skills') && flavor === 'modern') {
    // The credential the server saw is part of this skill's text; the manifest digests that text, redaction comes after the check.
    SKILL_FILES['skill://echo/SKILL.md'] = { mimeType: 'text/markdown', text: `---\nname: echo\ndescription: Its text contains the credential the server saw.\n---\nauthorization: ${secret}\n` };
    table['skills/list'] = async () => {
      state.skillRequests.push('skills/list');
      return { skills: skillEntries(), ttlMs: 0, cacheScope: 'shared' };
    };
    table['skills/get'] = async (params, h) => {
      state.skillRequests.push(`skills/get ${params.uri}`);
      const skill = skillEntries().find((e) => e.uri === params.uri);
      if (!skill) h.fail(INVALID_PARAMS, `Unknown skill: ${params.uri}`);
      return { skill, ttlMs: 0, cacheScope: 'shared' };
    };
    const read = table['resources/read'];
    table['resources/read'] = async (params, h) => {
      const content = SKILL_FILES[params.uri];
      if (content) {
        state.skillRequests.push(`resources/read ${params.uri}`);
        return { contents: [{ uri: params.uri, ...content }] };
      }
      if (read) return read(params, h);
      return h.fail(-32002, `Resource not found: ${params.uri}`);
    };
  }

  if (features.includes('completions')) {
    table['completion/complete'] = async (params) => {
      const { ref, argument, context } = params;
      state.completions.push({ ref, argument, context: context?.arguments });
      const prefix = String(argument.value ?? '');
      if (ref.type === 'ref/prompt' && ref.name === 'review' && argument.name === 'lang') {
        const values = LANGS.filter((v) => v.startsWith(prefix));
        return { completion: { values, total: values.length, hasMore: false } };
      }
      if (ref.type === 'ref/resource' && argument.name === 'date') {
        const values = DATES.filter((v) => v.startsWith(prefix));
        // An empty prefix matches far more than one page: the server says so.
        return { completion: prefix === '' ? { values, total: 40, hasMore: true } : { values, total: values.length, hasMore: false } };
      }
      return { completion: { values: [] } };
    };
  }

  table['tools/list'] = async () => {
    state.listCalls += 1;
    // `ttlMs`: the freshness hint a stateless server sends with its tool list.
    const listed = [...state.tools, ...(features.includes('roots') ? [ROOTS_TOOL] : []), ...(withTasks ? TASK_TOOLS : [])];
    return { tools: listed, ...(flavor === 'modern' && ttlMs !== undefined ? { ttlMs } : {}) };
  };

  table['tools/call'] = async (params, h) => {
    const { name, arguments: args = {} } = params;
    state.calls.push({ name, args });
    if (withTasks && (name === 'report_job' || name === 'must_task')) {
      const ms = Number(args.ms ?? 300);
      if (flavor === 'legacy') {
        if (params.task) {
          const t = startTask(name, args, 'task-augmented');
          return { task: { taskId: t.id, status: 'working', createdAt: iso(t.createdAt), lastUpdatedAt: iso(t.createdAt), ttl: 60000, pollInterval: 50 } };
        }
        if (name === 'must_task') return h.fail(-32601, 'Task augmentation is required for this tool');
        await new Promise((resolve) => setTimeout(resolve, ms));
        return taskResult({ ms });
      }
      if (h.clientCapabilities()?.extensions?.[TASKS_EXTENSION] && ms >= 100) {
        const t = startTask(name, args, 'extension');
        return { resultType: 'task', taskId: t.id, status: 'working', createdAt: iso(t.createdAt), lastUpdatedAt: iso(t.createdAt), ttlMs: 60000, pollIntervalMs: 50 };
      }
      state.taskRequests.push(`sync ${name}`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      return taskResult({ ms });
    }
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
        // A server asking its client: over stdio only on the old protocol (the HTTP fixture answers each request on a fresh server).
        const roots = h.clientCapabilities()?.roots;
        if (!roots) return { content: [{ type: 'text', text: 'roots: the client did not declare the capability' }] };
        const listed = await h.listRoots();
        return { content: [{ type: 'text', text: [`roots (listChanged: ${roots.listChanged === true}):`, ...listed.roots.map((r) => `${r.uri} ${r.name ?? ''}`.trimEnd())].join('\n') }] };
      }
      case 'echo_text':
        return { content: [{ type: 'text', text: `echo: ${args.message}` }] };
      case 'run_job': {
        const token = h.progressToken;
        if (token !== undefined) {
          await h.notify({ method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 2, message: 'halfway' } });
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
      case 'search':
      case 'batch_search':
        return { content: [{ type: 'text', text: `${name}: ${args.query ?? ''}` }] };
      case 'stats_get':
        return { content: [{ type: 'text', text: '{"count":"many"}' }], structuredContent: { count: 'many' } };
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  };

  const info = { name: 'cli-fixture', version: '0.0.0', ...(about.description ? { description: about.description } : {}), ...(about.websiteUrl ? { websiteUrl: about.websiteUrl } : {}) };
  return buildServer(flavor, info, capabilities, table, { ...(notifier ? { notifier } : {}), ...(about.instructions ? { instructions: about.instructions } : {}) });
}
