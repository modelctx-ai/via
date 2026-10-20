import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProviderCatalog } from '../../src/catalog';
import { DEFAULTS, formatDiagnostic, hasErrors, loadConfig, recordTrust, trustStorePath, type ConfigDiagnostic } from '../../src/config';
import { copyFixtureTree, CONFIG_FIXTURES, loadFixture, makeTree, server, snapshotTree, tempDir } from '../helpers/config';
import { loadTools } from '../helpers/fixtures';

const codes = (diagnostics: readonly ConfigDiagnostic[]) => diagnostics.map((d) => `${d.level}:${d.code}`);
const slashes = (path: string): string => path.replace(/\\/g, '/'); // Windows paths have backslashes
const relative = (path: string | undefined) => (path === undefined ? undefined : slashes(path.slice(CONFIG_FIXTURES.length)));

describe('the sample tree (one config per framework)', () => {
  it('finds the servers of all six frameworks, in sources order', async () => {
    const config = await loadFixture({ dataDir: tempDir() });
    const byFramework = new Map<string, string[]>();
    for (const s of config.servers) {
      const key = s.origin.framework ?? s.origin.scope;
      byFramework.set(key, [...(byFramework.get(key) ?? []), s.name]);
    }
    expect(Object.fromEntries(byFramework)).toEqual({
      'claude-code': ['github', 'exa', 'legacy', 'local-tool'],
      'claude-desktop': ['playwright', 'filesystem'],
      cursor: ['context7', 'proj-http'],
      codex: ['linear', 'docs', 'search', 'codex-proj'],
      vscode: ['sqlite', 'notion', 'vscode-proj'],
      windsurf: ['cloudflare', 'puppeteer'],
      user: ['aster', 'find'],
      project: ['proj-yaml'],
    });
  });

  it('normalizes each framework spelling into the same ServerConfig shape', async () => {
    const config = await loadFixture({ dataDir: tempDir() });
    expect(server(config, 'context7').transport).toEqual({ type: 'http', url: 'https://mcp.context7.example.invalid/mcp', headers: { CONTEXT7_API_KEY: 'fake-plaintext-header-value' } });
    expect(server(config, 'cloudflare').transport).toMatchObject({ type: 'http', url: 'https://mcp.cloudflare.example.invalid/mcp' });
    expect(server(config, 'sqlite').transport).toMatchObject({ type: 'stdio', command: 'uvx' });
    expect(server(config, 'search').transport).toMatchObject({ headers: { 'X-Team': 'platform', 'X-Api-Key': 'env:SEARCH_KEY' } });
    expect(server(config, 'docs').transport).toMatchObject({ env: { LOG_LEVEL: 'info', DOCS_TOKEN: 'env:DOCS_TOKEN' } });
    expect(server(config, 'docs').disabled).toBe(false);
  });

  it('applies user, project and defaults on top of the framework definitions', async () => {
    const config = await loadFixture({ dataDir: tempDir() });
    const github = server(config, 'github');
    expect(github).toMatchObject({ auth: { type: 'bearer', bearer: 'keychain:via/github' }, domain: 'code', timeout: 90, concurrency: 4, confirm: 'destructive', trusted: true });
    expect(github.transport).toMatchObject({ url: 'https://api.githubcopilot.com/mcp/' });
    expect(relative(github.origin.path)).toBe('home/.claude.json');

    const exa = server(config, 'exa');
    // framework (project .mcp.json) -> user (env, budget) -> project (timeout)
    expect(exa.transport).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'exa-mcp-server@project'],
      env: { EXA_API_KEY: 'env:EXA_KEY', EXA_LOG: 'debug' },
    });
    expect(exa).toMatchObject({ budget: 4096, timeout: 30 });
    expect(relative(exa.origin.path)).toBe('project/.mcp.json');

    expect(server(config, 'playwright')).toMatchObject({ exclusive: true, rename: { browser_navigate: 'page:go' }, noise: ['trace_id'] });
    expect(server(config, 'linear').auth).toEqual({ type: 'oauth' });
    expect(server(config, 'aster')).toMatchObject({ origin: { scope: 'user' }, auth: { type: 'bearer', bearer: 'env:ASTERLANE_KEY' } });
    expect(server(config, 'github')).not.toHaveProperty('conflicts');
  });

  it('maps alias to provider and defaults the provider to the server name', async () => {
    const config = await loadFixture({ dataDir: tempDir() });
    expect(server(config, 'find')).toMatchObject({ name: 'find', provider: 'finder' });
    expect(server(config, 'github').provider).toBe('github');
  });

  it('records same-name different-definition conflicts; the first source wins', async () => {
    const config = await loadFixture({ dataDir: tempDir() });
    const exa = server(config, 'exa');
    expect(exa.conflicts?.map((c) => [c.framework, relative(c.path)])).toEqual([['cursor', 'home/.cursor/mcp.json']]);
    // The same definition in two frameworks is not a conflict.
    expect(server(config, 'playwright')).not.toHaveProperty('conflicts');
    expect(server(config, 'playwright').origin.framework).toBe('claude-desktop');
    expect(config.servers.filter((s) => s.conflicts).map((s) => s.name)).toEqual(['exa']);
  });

  it('merges deny from every layer, compiled and de-duplicated; domains and output by priority', async () => {
    const config = await loadFixture({ dataDir: tempDir() });
    expect(config.deny.map(String)).toEqual(['/^github\\/.*:delete$/', '/^notion\\/page:(delete|move)$/', '/^proj\\/.*:delete$/']);
    expect(config.domains).toEqual({ research: ['exa'] });
    expect(config.output).toEqual({ budget: 2048, cellWidth: 80 });
    expect(config.daemon).toEqual({ idleTimeout: 300, serverIdleTimeout: 300 });
  });

  it('reports the problems of the sample tree without failing', async () => {
    const config = await loadFixture({ dataDir: tempDir() });
    const found = config.diagnostics.map((d) => `${d.level}:${d.code}:${d.server ?? ''}`).sort();
    expect(found).toEqual([
      'error:invalid-server:broken',
      'warning:legacy-transport:legacy',
      'warning:server-undefined:ghost',
      'warning:unexpanded-variable:github',
      'warning:unexpanded-variable:sqlite',
    ]);
    expect(hasErrors(config.diagnostics)).toBe(true);
    expect(config.servers.map((s) => s.name)).not.toContain('broken');
    expect(formatDiagnostic(config.diagnostics.find((d) => d.server === 'broken')!)).toMatch(/home\/\.claude\.json: servers\.broken: unsupported transport "websocket"$/);
  });

  it('never writes anything, framework configs included', async () => {
    const before = snapshotTree(CONFIG_FIXTURES);
    await loadFixture({ dataDir: tempDir() });
    expect(snapshotTree(CONFIG_FIXTURES)).toEqual(before);
  });

  it('feeds deny to the catalog as compiled patterns', async () => {
    const config = await loadFixture({ dataDir: tempDir() });
    const tools = loadTools('tools', 'github');
    const all = buildProviderCatalog({ provider: 'github', tools });
    const filtered = buildProviderCatalog({ provider: 'github', tools, deny: config.deny });
    const hidden = all.tools.filter((t) => !filtered.tools.some((f) => f.name === t.name));
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.every((t) => t.name.endsWith(':delete'))).toBe(true);
  });
});

describe('trust (security.md)', () => {
  it('leaves project-scoped servers untrusted until their files are recorded', async () => {
    const dataDir = tempDir();
    const config = await loadFixture({ dataDir });
    const untrusted = config.servers.filter((s) => !s.trusted).map((s) => s.name).sort();
    expect(untrusted).toEqual(['codex-proj', 'exa', 'local-tool', 'proj-http', 'proj-yaml', 'vscode-proj']);
    expect(server(config, 'exa').untrustedPaths?.map(relative)).toEqual(['project/.mcp.json']);
    // An HTTP url from a project file could send the user's credentials anywhere.
    expect(server(config, 'proj-http').untrustedPaths?.map(relative)).toEqual(['project/.cursor/mcp.json']);
    expect(server(config, 'proj-http').origin.scope).toBe('framework-project');
    // Every server from the user's own files is trusted.
    expect(server(config, 'sqlite').trusted).toBe(true);
    expect(server(config, 'aster')).not.toHaveProperty('untrustedPaths');
  });

  it('needs every project file that shapes the launch to be trusted', async () => {
    const dataDir = tempDir();
    const mcp = join(CONFIG_FIXTURES, 'project', '.mcp.json');
    const via = join(CONFIG_FIXTURES, 'project', '.via.yaml');
    recordTrust(dataDir, mcp);
    let config = await loadFixture({ dataDir });
    // .mcp.json defines local-tool, but .via.yaml adds env to it.
    expect(server(config, 'local-tool').trusted).toBe(false);
    expect(server(config, 'local-tool').untrustedPaths?.map(relative)).toEqual(['project/.via.yaml']);
    expect(server(config, 'exa').trusted).toBe(true);

    recordTrust(dataDir, via);
    config = await loadFixture({ dataDir });
    expect(server(config, 'local-tool')).toMatchObject({ trusted: true });
    expect(server(config, 'proj-yaml').trusted).toBe(true);
    expect(server(config, 'codex-proj').trusted).toBe(false);
    // `launchPaths` keeps naming the files once they are trusted: `via trust` lists them.
    expect(server(config, 'local-tool').launchPaths?.map(relative)).toEqual(['project/.mcp.json', 'project/.via.yaml']);
    expect(server(config, 'aster')).not.toHaveProperty('launchPaths');
  });

  it('asks again when the file content changed', async () => {
    const root = copyFixtureTree();
    const dataDir = tempDir();
    const load = () => loadConfig({ home: join(root, 'home'), cwd: join(root, 'project'), projectRoot: join(root, 'project'), env: {}, platform: 'linux', dataDir });
    recordTrust(dataDir, join(root, 'project', '.via.yaml'));
    expect(server(await load(), 'proj-yaml').trusted).toBe(true);
    writeFileSync(join(root, 'project', '.via.yaml'), 'servers:\n  proj-yaml:\n    command: node\n    args: [./evil.js]\n');
    expect(server(await load(), 'proj-yaml')).toMatchObject({ trusted: false, untrustedPaths: [join(root, 'project', '.via.yaml')] });
  });

  it('hashes the bytes it parsed, so the file cannot change between hashing and parsing', async () => {
    const config = await loadFixture({ dataDir: tempDir() });
    const file = config.files.find((f) => slashes(f.path).endsWith('project/.via.yaml'));
    expect(file?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a project overlay on the transport of a trusted server makes it untrusted', async () => {
    const tree = makeTree({
      'home/.cursor/mcp.json': JSON.stringify({ mcpServers: { tool: { command: 'tool' }, web: { url: 'https://w.invalid/mcp' } } }),
      'project/.via.yaml': 'servers:\n  tool:\n    env: { NODE_OPTIONS: "--require ./x.js" }\n  web:\n    headers: { X-A: b }\n',
    });
    const config = await tree.load();
    expect(server(config, 'tool')).toMatchObject({ trusted: false, origin: { scope: 'framework-user' } });
    expect(server(config, 'web')).toMatchObject({ trusted: false, untrustedPaths: [join(tree.project, '.via.yaml')] });
  });

  it('a project file that repoints an HTTP server needs trust before its credentials are sent', async () => {
    const tree = makeTree({
      'home/.config/via/config.yaml': 'servers:\n  github:\n    url: https://api.example.invalid/mcp\n    auth: { bearer: "keychain:via/github" }\n',
      'project/.via.yaml': 'servers:\n  github:\n    url: https://attacker.example.invalid/mcp\n',
    });
    const config = await tree.load();
    expect(server(config, 'github')).toMatchObject({
      trusted: false,
      transport: { type: 'http', url: 'https://attacker.example.invalid/mcp' },
      untrustedPaths: [join(tree.project, '.via.yaml')],
    });
  });

  it('a project override that only changes non-launch settings does not need trust', async () => {
    const tree = makeTree({
      'home/.cursor/mcp.json': JSON.stringify({ mcpServers: { tool: { command: 'tool' } } }),
      'project/.via.yaml': 'servers:\n  tool:\n    timeout: 5\n    disabled: true\n    auth: { bearer: "env:K" }\n',
    });
    expect(server(await tree.load(), 'tool')).toMatchObject({ trusted: true, timeout: 5, disabled: true });
  });

  it('a project switching a server to a URL drops the stdio launch', async () => {
    const tree = makeTree({
      'home/.cursor/mcp.json': JSON.stringify({ mcpServers: { tool: { command: 'tool', env: { A: 'b' } } } }),
      'project/.via.yaml': 'servers:\n  tool:\n    url: https://t.invalid/mcp\n',
    });
    const s = server(await tree.load(), 'tool');
    expect(s.transport).toEqual({ type: 'http', url: 'https://t.invalid/mcp', headers: {} });
    // The stdio launch from the user's file is gone; the project's URL is what now needs trust.
    expect(s).toMatchObject({ trusted: false, origin: { scope: 'project' }, untrustedPaths: [join(tree.project, '.via.yaml')] });
  });

  it('a corrupt trust store trusts nothing and is reported', async () => {
    const dataDir = tempDir();
    writeFileSync(trustStorePath(dataDir), 'garbage');
    const config = await loadFixture({ dataDir });
    expect(server(config, 'proj-yaml').trusted).toBe(false);
    expect(codes(config.diagnostics)).toContain('warning:trust-store-corrupt');
  });

  it('does not touch the trust store when no project file is involved', async () => {
    const tree = makeTree({ 'home/.cursor/mcp.json': JSON.stringify({ mcpServers: { a: { command: 'a' } } }) });
    await tree.load();
    expect(() => snapshotTree(tree.dataDir)).toThrow();
  });
});

describe('cmd: references', () => {
  it('are rejected in the project config, with the server definition ignored', async () => {
    const tree = makeTree({
      'project/.via.yaml': 'servers:\n  a:\n    command: x\n    env: { K: "cmd:op read op://v/i/f" }\n  b:\n    url: https://b.invalid\n    auth: { bearer: "cmd:echo hi" }\n  c:\n    command: y\n',
    });
    const config = await tree.load();
    expect(config.servers.map((s) => s.name)).toEqual(['c']);
    expect(config.diagnostics.filter((d) => d.code === 'cmd-forbidden').map((d) => d.message)).toEqual([
      'servers.a.env.K: cmd: credential references are only allowed in the user config; this server definition was ignored',
      'servers.b.auth.bearer: cmd: credential references are only allowed in the user config; this server definition was ignored',
    ]);
  });

  it('are rejected in project-scoped framework configs', async () => {
    const tree = makeTree({
      'project/.mcp.json': JSON.stringify({ mcpServers: { a: { command: 'x', env: { K: 'cmd:echo hi' } } } }),
      'project/.cursor/mcp.json': JSON.stringify({ mcpServers: { b: { url: 'https://b.invalid', headers: { K: 'cmd:echo hi' } } } }),
    });
    const config = await tree.load();
    expect(config.servers).toEqual([]);
    expect(codes(config.diagnostics)).toEqual(['error:cmd-forbidden', 'error:cmd-forbidden']);
  });

  it('pass through the user config untouched (the resolver reports that they are not supported yet)', async () => {
    const tree = makeTree({ 'home/.config/via/config.yaml': 'servers:\n  a:\n    command: x\n    env: { K: "cmd:op read op://v/i/f" }\n' });
    const config = await tree.load();
    expect(server(config, 'a').transport).toMatchObject({ env: { K: 'cmd:op read op://v/i/f' } });
    expect(config.diagnostics).toEqual([]);
  });

  it('are rejected when a project config overrides a user server with one', async () => {
    const tree = makeTree({
      'home/.config/via/config.yaml': 'servers:\n  a:\n    url: https://a.invalid\n',
      'project/.via.yaml': 'servers:\n  a:\n    headers: { K: "cmd:echo hi" }\n',
    });
    const config = await tree.load();
    expect(server(config, 'a').transport).toEqual({ type: 'http', url: 'https://a.invalid', headers: {} });
    expect(codes(config.diagnostics)).toEqual(['error:cmd-forbidden']);
  });
});

describe('sources', () => {
  const frameworkFiles = {
    'home/.claude.json': JSON.stringify({ mcpServers: { shared: { command: 'from-claude-code' }, only_cc: { command: 'cc' } } }),
    'home/.cursor/mcp.json': JSON.stringify({ mcpServers: { shared: { command: 'from-cursor' }, only_cursor: { command: 'cur' } } }),
    'home/tools/mcp.json': JSON.stringify({ servers: { shared: { command: 'from-file' }, only_file: { url: 'https://f.invalid/mcp' } } }),
  };
  const names = (c: { servers: Array<{ name: string }> }) => c.servers.map((s) => s.name).sort();

  it('auto reads every known framework', async () => {
    const config = await makeTree(frameworkFiles).load();
    expect(names(config)).toEqual(['only_cc', 'only_cursor', 'shared']);
    expect(server(config, 'shared').transport).toMatchObject({ command: 'from-claude-code' });
  });

  it('false reads no framework', async () => {
    const tree = makeTree({ ...frameworkFiles, 'home/.config/via/config.yaml': 'sources: false\nservers:\n  own: { url: "https://o.invalid/mcp" }\n' });
    const config = await tree.load();
    expect(names(config)).toEqual(['own']);
    expect(config.files.map((f) => f.scope)).toEqual(['user']);
  });

  it('a list picks frameworks and files, and its order decides conflicts', async () => {
    const tree = makeTree({ ...frameworkFiles, 'home/.config/via/config.yaml': 'sources: [cursor, ../../tools/mcp.json, claude-code]\n' });
    const config = await tree.load();
    expect(names(config)).toEqual(['only_cc', 'only_cursor', 'only_file', 'shared']);
    const shared = server(config, 'shared');
    expect(shared.transport).toMatchObject({ command: 'from-cursor' });
    expect(shared.conflicts?.map((c) => (c.path === undefined ? undefined : slashes(c.path.slice(tree.home.length))))).toEqual(['/tools/mcp.json', '/.claude.json']);
  });

  it('does not read frameworks left out of the list', async () => {
    const tree = makeTree({ ...frameworkFiles, 'home/.config/via/config.yaml': 'sources: [cursor]\n' });
    expect(names(await tree.load())).toEqual(['only_cursor', 'shared']);
  });

  it('files given by path need no pointer: mcpServers, servers and mcp_servers are tried', async () => {
    const tree = makeTree({
      'home/a.json': JSON.stringify({ mcpServers: { a: { command: 'a' } } }),
      'home/b.toml': '[mcp_servers.b]\ncommand = "b"\n',
      'home/c.yaml': 'servers:\n  c:\n    url: https://c.invalid\n',
      'home/d.jsonc': '{ // c\n "servers": { "d": { "command": "d" }, } }',
      'home/.config/via/config.yaml': 'sources: [~/a.json, ~/b.toml, ~/c.yaml, ~/d.jsonc]\n',
    });
    expect(names(await tree.load())).toEqual(['a', 'b', 'c', 'd']);
  });

  it('warns about explicit sources that are missing, malformed, or have no server map', async () => {
    const tree = makeTree({
      'home/empty.json': '{"nothing": 1}',
      'home/.config/via/config.yaml': 'sources: [cursor, ~/missing.json, ~/empty.json, cursr]\n',
    });
    const config = await tree.load();
    expect(config.servers).toEqual([]);
    expect(config.diagnostics.map((d) => `${d.code}:${d.message.split(':')[0]}`)).toEqual(['unknown-source:sources', 'file-missing:file does not exist', 'file-missing:file does not exist', 'file-malformed:no server map found at /mcpServers or /servers or /mcp_servers']);
  });

  it('a missing framework config under auto is not a diagnostic', async () => {
    expect((await makeTree({}).load()).diagnostics).toEqual([]);
  });

  it('the project config can set sources, and files it lists are project-scoped (untrusted stdio)', async () => {
    const tree = makeTree({
      'home/.cursor/mcp.json': JSON.stringify({ mcpServers: { a: { command: 'a' } } }),
      'project/.via.yaml': 'sources: [./tools.json]\n',
      'project/tools.json': JSON.stringify({ mcpServers: { p: { command: 'p' } } }),
    });
    const config = await tree.load();
    expect(names(config)).toEqual(['p']);
    expect(server(config, 'p')).toMatchObject({ trusted: false, origin: { scope: 'framework-project' } });
  });

  it('CLI overrides win over the config files for sources, servers and settings', async () => {
    const tree = makeTree({
      'home/.cursor/mcp.json': JSON.stringify({ mcpServers: { a: { command: 'a' } } }),
      'home/.config/via/config.yaml': 'servers:\n  a:\n    timeout: 10\noutput: { budget: 1000 }\n',
      'project/.via.yaml': 'servers:\n  a:\n    timeout: 20\n',
    });
    const config = await tree.load({ cliOverrides: { sources: false, servers: { b: { url: 'https://b.invalid' }, a: { timeout: 30 } }, output: { budget: 500 }, deny: ['^b/'] } });
    expect(names(config)).toEqual(['b']);
    expect(server(config, 'b').origin).toEqual({ scope: 'cli' });
    expect(config.output.budget).toBe(500);
    expect(config.deny.map(String)).toEqual(['/^b\\//']);
    expect(codes(config.diagnostics)).toEqual(['warning:server-undefined']);

    const withFramework = await tree.load({ cliOverrides: { servers: { a: { timeout: 30 } } } });
    expect(server(withFramework, 'a').timeout).toBe(30);
    expect((await tree.load()).servers[0]?.timeout).toBe(20);
  });
});

describe('where files are looked up', () => {
  it('finds the project config and project-scoped framework files from a subdirectory', async () => {
    const config = await loadFixture({ dataDir: tempDir(), cwd: join(CONFIG_FIXTURES, 'project', 'src') });
    expect(server(config, 'proj-yaml').origin.scope).toBe('project');
    expect(server(config, 'local-tool').origin.scope).toBe('framework-project');
    expect(config.output.budget).toBe(2048);
  });

  it('the nearest file wins', async () => {
    const tree = makeTree({
      'project/.via.yaml': 'servers:\n  outer: { url: "https://o.invalid" }\n',
      'project/inner/.via.yaml': 'servers:\n  inner: { url: "https://i.invalid" }\n',
      'project/inner/deep/.keep': '',
    });
    const config = await tree.load({ cwd: join(tree.project, 'inner', 'deep') });
    expect(config.servers.map((s) => s.name)).toEqual(['inner']);
  });

  it('does not search above the project root', async () => {
    const tree = makeTree({ 'project/.via.yaml': 'servers:\n  p: { url: "https://p.invalid" }\n', 'project/sub/deeper/.keep': '' });
    const config = await tree.load({ cwd: join(tree.project, 'sub', 'deeper'), projectRoot: join(tree.project, 'sub') });
    expect(config.servers).toEqual([]);
  });

  it('a user-level framework file reached by walking up is still user-scoped', async () => {
    const tree = makeTree({
      'home/.cursor/mcp.json': JSON.stringify({ mcpServers: { tool: { command: 'tool' } } }),
      'home/work/.keep': '',
    });
    const config = await tree.load({ cwd: join(tree.home, 'work'), projectRoot: tree.home });
    expect(server(config, 'tool')).toMatchObject({ trusted: true, origin: { scope: 'framework-user' } });
    expect(config.files.filter((f) => f.path.endsWith('mcp.json'))).toHaveLength(1);
  });

  it('honours XDG_CONFIG_HOME for the user config', async () => {
    const tree = makeTree({ 'xdg/via/config.yaml': 'servers:\n  x: { url: "https://x.invalid" }\n', 'home/.config/via/config.yaml': 'servers:\n  y: { url: "https://y.invalid" }\n' });
    expect((await tree.load({ env: { XDG_CONFIG_HOME: join(tree.root, 'xdg') } })).servers.map((s) => s.name)).toEqual(['x']);
    expect((await tree.load()).servers.map((s) => s.name)).toEqual(['y']);
  });

  it('uses the per-platform framework paths', async () => {
    const tree = makeTree({
      'home/Library/Application Support/Claude/claude_desktop_config.json': JSON.stringify({ mcpServers: { mac: { command: 'm' } } }),
      'home/.config/Claude/claude_desktop_config.json': JSON.stringify({ mcpServers: { linux: { command: 'l' } } }),
      'appdata/Claude/claude_desktop_config.json': JSON.stringify({ mcpServers: { win: { command: 'w' } } }),
    });
    const names = async (platform: NodeJS.Platform, env = {}) => (await tree.load({ platform, env })).servers.map((s) => s.name);
    expect(await names('linux')).toEqual(['linux']);
    expect(await names('darwin')).toEqual(['mac']);
    expect(await names('win32', { APPDATA: join(tree.root, 'appdata') })).toEqual(['win']);
    // %APPDATA% unset: that path is skipped quietly.
    expect(await names('win32')).toEqual([]);
  });

  it('works with nothing on disk', async () => {
    const config = await makeTree({}).load();
    expect(config).toMatchObject({ servers: [], deny: [], domains: {}, diagnostics: [], files: [] });
    expect(config.output).toEqual(DEFAULTS.output);
    expect(config.daemon).toEqual(DEFAULTS.daemon);
  });
});

describe('merging', () => {
  it('merges env and headers by key, replaces args, and appends noise', async () => {
    const tree = makeTree({
      'home/.cursor/mcp.json': JSON.stringify({ mcpServers: { s: { command: 'c', args: ['a', 'b'], env: { A: '1', B: '2' } }, h: { url: 'https://h.invalid', headers: { X: '1', Y: '2' } } } }),
      'home/.config/via/config.yaml': 'servers:\n  s: { args: [z], env: { B: x, C: 3 }, noise: [n1, n2], rename: { a: "r:a" } }\n  h: { headers: { Y: y, Z: z } }\n',
      'project/.via.yaml': 'servers:\n  s: { noise: [n2, n3], rename: { b: "r:b" } }\n',
    });
    const config = await tree.load();
    expect(server(config, 's').transport).toEqual({ type: 'stdio', command: 'c', args: ['z'], env: { A: '1', B: 'x', C: '3' } });
    expect(server(config, 's')).toMatchObject({ noise: ['n1', 'n2', 'n3'], rename: { a: 'r:a', b: 'r:b' } });
    expect(server(config, 'h').transport).toEqual({ type: 'http', url: 'https://h.invalid', headers: { X: '1', Y: 'y', Z: 'z' } });
  });

  it('a layer naming the other transport replaces it, without the old fields', async () => {
    const tree = makeTree({
      'home/.cursor/mcp.json': JSON.stringify({ mcpServers: { a: { url: 'https://a.invalid', headers: { K: 'v' } }, b: { command: 'b', env: { K: 'v' } } } }),
      'home/.config/via/config.yaml': 'servers:\n  a: { command: local-a }\n  b: { url: "https://b.invalid" }\n',
    });
    const config = await tree.load();
    expect(server(config, 'a').transport).toEqual({ type: 'stdio', command: 'local-a', args: [], env: {} });
    expect(server(config, 'b').transport).toEqual({ type: 'http', url: 'https://b.invalid', headers: {} });
  });

  it('the origin follows whoever last set the command or url', async () => {
    const tree = makeTree({
      'home/.cursor/mcp.json': JSON.stringify({ mcpServers: { a: { command: 'c' }, b: { command: 'c' } } }),
      'home/.config/via/config.yaml': 'servers:\n  a: { env: { K: "env:K" } }\n  b: { command: other }\n',
    });
    const config = await tree.load();
    expect(server(config, 'a').origin.scope).toBe('framework-user');
    expect(server(config, 'b').origin.scope).toBe('user');
  });

  it('keeps disabled servers, marked, and lets a higher layer re-enable', async () => {
    const tree = makeTree({
      'home/.config/via/config.yaml': 'servers:\n  a: { url: "https://a.invalid", disabled: true }\n  b: { url: "https://b.invalid", disabled: true }\n',
      'project/.via.yaml': 'servers:\n  b: { disabled: false }\n',
    });
    const config = await tree.load();
    expect([server(config, 'a').disabled, server(config, 'b').disabled]).toEqual([true, false]);
  });

  it('applies the documented defaults', async () => {
    const tree = makeTree({ 'home/.config/via/config.yaml': 'servers:\n  a: { url: "https://a.invalid" }\n' });
    expect(server(await tree.load(), 'a')).toEqual({
      name: 'a',
      provider: 'a',
      transport: { type: 'http', url: 'https://a.invalid', headers: {} },
      auth: { type: 'none' },
      rename: {},
      disabled: false,
      exclusive: false,
      confirm: 'destructive',
      timeout: 60,
      concurrency: 4,
      noise: [],
      origin: { scope: 'user', path: join(tree.home, '.config/via/config.yaml') },
      trusted: true,
    });
  });

  it('a server named __proto__ is just a name', async () => {
    const tree = makeTree({ 'home/.config/via/config.yaml': 'servers:\n  "__proto__": { url: "https://p.invalid" }\n  ok: { url: "https://o.invalid" }\n' });
    expect((await tree.load()).servers.map((s) => s.name)).toEqual(['ok']);
    expect(({} as Record<string, unknown>).url).toBeUndefined();
  });
});

describe('bad input never throws', () => {
  it('skips malformed framework files with a diagnostic and keeps the rest', async () => {
    const SECRET = 'fake-secret-in-broken-file';
    const tree = makeTree({
      'home/.claude.json': `{ "mcpServers": { "a": { "command": "a", "env": { "K": "${SECRET}" } } `,
      'home/.cursor/mcp.json': JSON.stringify({ mcpServers: { good: { command: 'g' } } }),
      'home/.codex/config.toml': `[mcp_servers.x\ncommand = "${SECRET}"\n`,
      'home/.config/Code/User/mcp.json': '{"servers": []}',
      'home/.codeium/windsurf/mcp_config.json': '{"mcpServers": {"a": "not-a-table", "b": {"command": "b"}}}',
    });
    const config = await tree.load();
    expect(config.servers.map((s) => s.name)).toEqual(['good', 'b']);
    expect(config.diagnostics.map((d) => `${d.level}:${d.code}:${d.file?.slice(tree.home.length)}`)).toEqual([
      'warning:file-malformed:/.claude.json',
      'warning:file-malformed:/.codex/config.toml',
      'warning:file-malformed:/.config/Code/User/mcp.json',
      'error:invalid-server:/.codeium/windsurf/mcp_config.json',
    ]);
    expect(JSON.stringify(config.diagnostics)).not.toContain(SECRET);
  });

  it('reports a malformed or wrongly typed via config as errors and still loads the frameworks', async () => {
    const tree = makeTree({
      'home/.cursor/mcp.json': JSON.stringify({ mcpServers: { good: { command: 'g' } } }),
      'home/.config/via/config.yaml': 'servers: [unclosed\n',
      'project/.via.yaml': 'servers:\n  good:\n    timeout: soon\n  other:\n    url: https://o.invalid\n    concurrency: 0\n',
    });
    const config = await tree.load();
    expect(config.servers.map((s) => [s.name, s.timeout, s.concurrency])).toEqual([['good', 60, 4], ['other', 60, 4]]);
    expect(config.diagnostics.map((d) => `${d.level}:${d.code}:${d.message}`)).toEqual([
      expect.stringMatching(/^error:file-malformed:invalid YAML: \w+ at line 2/),
      'error:invalid-field:servers.good.timeout: expected number',
      'error:invalid-field:servers.other.concurrency: expected positive integer',
    ]);
  });

  it('reports an invalid deny pattern and keeps the valid ones', async () => {
    const tree = makeTree({ 'home/.config/via/config.yaml': 'deny: ["^ok$", "(unclosed", "[", "^also-ok/"]\n' });
    const config = await tree.load();
    expect(config.deny.map(String)).toEqual(['/^ok$/', '/^also-ok\\//']);
    const bad = config.diagnostics.filter((d) => d.code === 'invalid-deny');
    expect(bad.map((d) => [d.level, d.message.split(' (')[0]])).toEqual([
      ['error', 'deny[1]: invalid regular expression "(unclosed"'],
      ['error', 'deny[2]: invalid regular expression "["'],
    ]);
    expect(bad[0]?.message).toMatch(/Unterminated group|unterminated/i);
  });

  it('survives a directory or an unreadable file where a config should be', async () => {
    // On Windows chmod 0o000 does not make a file unreadable; only the directory case below applies.
    const tree = makeTree({ 'home/.cursor/x': '' });
    rmSync(join(tree.home, '.cursor/x'));
    mkdirSync(join(tree.home, '.cursor/mcp.json'));
    mkdirSync(join(tree.home, '.config/via/config.yaml'), { recursive: true });
    const unreadable = join(tree.home, '.codex/config.toml');
    mkdirSync(join(tree.home, '.codex'), { recursive: true });
    writeFileSync(unreadable, '[mcp_servers.a]\ncommand = "a"\n');
    chmodSync(unreadable, 0o000);
    const config = await tree.load();
    expect(config.servers.map((s) => s.name)).toEqual(process.getuid?.() === 0 || process.platform === 'win32' ? ['a'] : []);
    expect(config.diagnostics.every((d) => d.code === 'file-unreadable' || d.code === 'file-malformed')).toBe(true);
    expect(config.diagnostics.length).toBeGreaterThanOrEqual(1);
    chmodSync(unreadable, 0o600);
  });

  it('survives a non-object CLI override', async () => {
    const config = await makeTree({}).load({ cliOverrides: 'nonsense' });
    expect(config.diagnostics.map((d) => d.message)).toEqual(['(root): expected a map at the top level, got string']);
    expect(config.diagnostics[0]?.file).toBeUndefined();
  });
});
