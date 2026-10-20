// Realistic tools/call results used by the rendering snapshot tests.

/** `github issue:list`: a GitHub-style payload full of noise fields and empty values. */
export const githubIssues = [
  {
    number: 12,
    title: 'Support OAuth DCR',
    state: 'open',
    node_id: 'I_kwDOAbc123',
    url: 'https://api.github.com/repos/acme/api/issues/12',
    html_url: 'https://github.com/acme/api/issues/12',
    repository_url: 'https://api.github.com/repos/acme/api',
    labels_url: 'https://api.github.com/repos/acme/api/issues/12/labels{/name}',
    comments_url: 'https://api.github.com/repos/acme/api/issues/12/comments',
    user: { login: 'octocat', id: 1, node_id: 'MDQ6VXNlcjE=', gravatar_id: '', avatar_url: 'https://avatars.example/u/1', url: 'https://api.github.com/users/octocat' },
    labels: [{ name: 'auth', color: 'ededed', node_id: 'LA_1' }],
    assignee: null,
    milestone: null,
    comments: 3,
    body: '',
    created_at: '2026-10-10T08:00:00Z',
    updated_at: '2026-10-18T09:30:00Z',
    _links: { self: { href: 'https://api.github.com/repos/acme/api/issues/12' } },
  },
  {
    number: 11,
    title: 'Group inference too eager when a provider has fewer than six servers',
    state: 'open',
    node_id: 'I_kwDOAbc124',
    url: 'https://api.github.com/repos/acme/api/issues/11',
    html_url: 'https://github.com/acme/api/issues/11',
    user: { login: 'hubot', id: 2, node_id: 'MDQ6VXNlcjI=', gravatar_id: '' },
    labels: [{ name: 'catalog', color: 'ededed' }, { name: 'bug', color: 'd73a4a' }],
    assignee: { login: 'octocat', id: 1 },
    comments: 0,
    created_at: '2026-10-09T08:00:00Z',
    updated_at: '2026-10-17T11:00:00Z',
  },
  {
    number: 9,
    title: 'Windows named pipes',
    state: 'closed',
    node_id: 'I_kwDOAbc125',
    url: 'https://api.github.com/repos/acme/api/issues/9',
    html_url: 'https://github.com/acme/api/issues/9',
    user: { login: 'octocat', id: 1 },
    labels: [{ name: 'daemon' }],
    comments: 7,
    created_at: '2026-10-01T08:00:00Z',
    updated_at: '2026-10-12T16:45:00Z',
  },
];

/** `linear issue:create` */
export const linearIssue = {
  id: 'ENG-123',
  url: 'https://linear.app/acme/issue/ENG-123',
  state: 'Backlog',
};

/** A single issue with nested objects, arrays and a multi-line body. */
export const githubIssue = {
  number: 42,
  title: 'Login returns 500',
  state: 'open',
  node_id: 'I_kwDOAbc126',
  html_url: 'https://github.com/acme/api/issues/42',
  user: { login: 'octocat', id: 1, node_id: 'MDQ6VXNlcjE=' },
  labels: [{ name: 'bug' }, { name: 'p1' }],
  assignees: [],
  milestone: null,
  body: 'Steps to reproduce:\n1. Open /login\n2. Submit the form\n\nExpected: 200\nActual: 500',
  reactions: { total_count: 2, '+1': 2, '-1': 0, laugh: 0 },
  comments_list: [
    { author: 'hubot', body: 'Reproduced on main.', created_at: '2026-10-11T10:00:00Z' },
    { author: 'octocat', body: 'Fix is in #43.', created_at: '2026-10-12T10:00:00Z' },
  ],
};

/** `exa web:search`: results with long URLs and scores. */
export const webResults = Array.from({ length: 8 }, (_, i) => ({
  title: ['Rust MCP SDK', 'Model Context Protocol servers', 'Building an MCP client', 'MCP transports explained', 'Streamable HTTP in practice', 'stdio vs HTTP for local servers', 'Writing tools that agents like', 'Schema design for tool arguments'][i],
  url: `https://example.org/articles/${['rust-mcp-sdk', 'mcp-servers', 'building-an-mcp-client', 'mcp-transports', 'streamable-http', 'stdio-vs-http', 'agent-friendly-tools', 'schema-design'][i]}`,
  score: [0.91, 0.88, 0.84, 0.8, 0.77, 0.75, 0.7, 0.66][i],
  publishedDate: `2026-0${(i % 9) + 1}-1${i % 9}`,
}));

/** Chinese titles, to check double-width alignment. */
export const chineseIssues = [
  { number: 1, title: '支持 OAuth 动态客户端注册', state: 'open', labels: '认证' },
  { number: 2, title: '拆分规则：动词表需要补充', state: 'open', labels: 'catalog' },
  { number: 10, title: 'Windows 命名管道', state: 'closed', labels: 'daemon' },
];

/** A large listing for truncation and cursor tests. */
export const manyRows = Array.from({ length: 60 }, (_, i) => ({
  id: 1000 + i,
  name: `service-${String(i).padStart(3, '0')}`,
  status: i % 7 === 0 ? 'degraded' : 'healthy',
  region: ['us-east', 'eu-west', 'ap-south'][i % 3],
}));

export const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
