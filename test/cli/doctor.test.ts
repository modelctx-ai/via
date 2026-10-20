import { describe, expect, it } from 'vitest';
import { BUNDLED_FRAMEWORKS, type LoadedConfig, type ServerConfig } from '../../src/config';
import { BYTES_PER_TOKEN, renderDoctor, type ServerProbe } from '../../src/cli/doctor';
import { makeTree } from '../helpers/config';
import { FAKE_SECRET } from '../helpers/render';

const NOT_A_CREDENTIAL = 'plain-value-for-tests';

function server(name: string, patch: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name,
    provider: name,
    transport: { type: 'http', url: `https://${name}.example.com/mcp`, headers: {} },
    auth: { type: 'none' },
    rename: {},
    disabled: false,
    exclusive: false,
    confirm: 'destructive',
    timeout: 60,
    concurrency: 4,
    noise: [],
    origin: { scope: 'user', path: '/home/u/.config/via/config.yaml' },
    trusted: true,
    ...patch,
  };
}

function config(servers: ServerConfig[], diagnostics: LoadedConfig['diagnostics'] = []): LoadedConfig {
  return {
    servers,
    deny: [],
    domains: {},
    output: { budget: 8192, cellWidth: 80 },
    daemon: { idleTimeout: 600, serverIdleTimeout: 300 },
    diagnostics,
    files: [],
  };
}

const probe = (name: string, extra: Partial<ServerProbe> = {}): ServerProbe => ({ server: name, provider: name, status: 'ok', ...extra });
const cursorOrigin = { scope: 'framework-user', path: '/home/u/.cursor/mcp.json', framework: 'cursor' } as const;
const claudeOrigin = { scope: 'framework-user', path: '/home/u/.claude.json', framework: 'claude-code' } as const;

describe('renderDoctor', () => {
  it('reports a healthy setup with exit code 0', async () => {
    const out = renderDoctor({ config: config([server('github'), server('exa')]), frameworks: BUNDLED_FRAMEWORKS, probes: [probe('github'), probe('exa')] });
    expect(out.exitCode).toBe(0);
    await expect(`${out.text}\n`).toMatchFileSnapshot('./__snapshots__/doctor-healthy.txt');
  });

  it('says so when there are no servers at all', () => {
    const out = renderDoctor({ config: config([]), frameworks: BUNDLED_FRAMEWORKS, probes: [] });
    expect(out.text.split('\n')[0]).toBe('servers   none configured');
    expect(out.exitCode).toBe(0);
  });

  it('lists frameworks with server counts, token estimates and disable hints', async () => {
    const servers = [
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((n) => server(n, { origin: claudeOrigin })),
      ...['g', 'h', 'i'].map((n) => server(n, { origin: cursorOrigin })),
      server('mine'),
    ];
    const probes = servers.map((s, i) => probe(s.name, { schemaBytes: s.name === 'mine' ? 90_000 : 7_000 + i * 100 }));
    const out = renderDoctor({ config: config(servers), frameworks: BUNDLED_FRAMEWORKS, probes });
    expect(out.exitCode).toBe(0);
    await expect(`${out.text}\n`).toMatchFileSnapshot('./__snapshots__/doctor-frameworks.txt');
  });

  it('estimates tokens at the documented bytes-per-token ratio', () => {
    expect(BYTES_PER_TOKEN).toBe(4);
    const mk = (bytes: number) =>
      renderDoctor({
        config: config([server('a', { origin: cursorOrigin })]),
        frameworks: BUNDLED_FRAMEWORKS,
        probes: [probe('a', { schemaBytes: bytes })],
      }).text;
    expect(mk(3_000)).toContain('1 server · ~750 tokens/turn');
    expect(mk(12_000)).toContain('~3k tokens/turn');
    expect(mk(14_000)).toContain('~3.5k tokens/turn');
    expect(mk(164_000)).toContain('~41k tokens/turn');
  });

  it('does not invent a size when no schema size is known', () => {
    const text = renderDoctor({ config: config([server('a', { origin: cursorOrigin })]), frameworks: BUNDLED_FRAMEWORKS, probes: [probe('a')] }).text;
    expect(text).toContain('1 server · size unknown');
  });

  it('counts a server under every framework that defines it differently (conflicts)', () => {
    const s = server('shared', { origin: cursorOrigin, conflicts: [claudeOrigin] });
    const text = renderDoctor({ config: config([s]), frameworks: BUNDLED_FRAMEWORKS, probes: [probe('shared', { schemaBytes: 4000 })] }).text;
    expect(text).toMatch(/claude-code {3}1 server · ~1k tokens\/turn/);
    expect(text).toMatch(/cursor {8}1 server · ~1k tokens\/turn/);
  });

  it('keeps unknown frameworks, without a hint', () => {
    const s = server('x', { origin: { scope: 'framework-user', path: '/f.json', framework: 'mystery' } });
    const text = renderDoctor({ config: config([s]), frameworks: BUNDLED_FRAMEWORKS, probes: [probe('x', { schemaBytes: 400 })] }).text;
    expect(text).toContain('mystery   1 server · ~100 tokens/turn');
    expect(text).not.toContain('hint:');
  });

  it('names problem servers, gives next steps, and exits with the highest code', async () => {
    const servers = [
      server('github'),
      server('linear', { auth: { type: 'oauth' } }),
      server('exa', { auth: { type: 'bearer', bearer: 'env:EXA_KEY' } }),
      server('playwright'),
      server('acme', { trusted: false, untrustedPaths: ['/work/repo/.via.yaml', '/work/repo/.mcp.json'] }),
      server('old', { disabled: true }),
    ];
    const probes = [
      probe('github'),
      probe('linear', { status: 'needs-auth', message: 'no stored token' }),
      probe('exa', { status: 'needs-auth', message: 'environment variable EXA_KEY is not set', next: 'export EXA_KEY=<value>' }),
      probe('playwright', { status: 'error', message: 'cannot start playwright: spawn npx ENOENT\n  at somewhere' }),
      probe('acme', { status: 'untrusted' }),
      probe('old', { status: 'disabled' }),
    ];
    const out = renderDoctor({ config: config(servers), frameworks: BUNDLED_FRAMEWORKS, probes });
    expect(out.exitCode).toBe(6);
    await expect(`${out.text}\n`).toMatchFileSnapshot('./__snapshots__/doctor-problems.txt');
  });

  it.each([
    [['needs-auth'], 4],
    [['untrusted'], 5],
    [['needs-auth', 'untrusted'], 5],
    [['ok', 'disabled'], 0],
    [['error', 'needs-auth'], 6],
  ] as const)('exit code for statuses %j is %i', (statuses, code) => {
    const servers = statuses.map((_, i) => server(`s${i}`));
    const probes = statuses.map((status, i) => probe(`s${i}`, { status }));
    expect(renderDoctor({ config: config(servers), frameworks: [], probes }).exitCode).toBe(code);
  });

  it('hints at an OAuth login store that cannot be written, without changing the exit code', () => {
    const warning = { message: 'the OAuth login store /home/u/.local/share/via/oauth is not writable, so a refreshed token cannot be saved', next: 'chmod u+w /home/u/.local/share/via/oauth' };
    const out = renderDoctor({ config: config([server('linear', { auth: { type: 'oauth' } })]), frameworks: [], probes: [probe('linear', { warning })], home: '/home/u' });
    expect(out.exitCode).toBe(0);
    expect(out.text).toContain('servers   1 ok');
    expect(out.text).toContain('  linear: warning: the OAuth login store ~/.local/share/via/oauth is not writable, so a refreshed token cannot be saved\n    next: chmod u+w ~/.local/share/via/oauth\n');
  });

  it('flags untrusted servers that were never probed', () => {
    const s = server('acme', { trusted: false, untrustedPaths: ['/work/.via.yaml'] });
    const out = renderDoctor({ config: config([s]), frameworks: [], probes: [] });
    expect(out.text).toContain('1 untrusted (acme)');
    expect(out.text).toContain('next: via trust /work/.via.yaml');
    expect(out.exitCode).toBe(5);
  });

  it('shows config diagnostics and catalog warnings; only errors change the exit code', async () => {
    const diagnostics: LoadedConfig['diagnostics'] = [
      { level: 'warning', code: 'unknown-field', message: 'servers.github.timout: unknown field', file: '/home/u/.config/via/config.yaml', server: 'github' },
      { level: 'error', code: 'invalid-deny', message: 'deny[0]: invalid regular expression "("; the rule was ignored', file: '/home/u/.config/via/config.yaml' },
      { level: 'error', code: 'cmd-forbidden', message: 'servers.x.env.K: cmd: credential references are only allowed in the user config; this server definition was ignored', file: '/work/.via.yaml', server: 'x' },
      { level: 'info', code: 'legacy-transport', message: 'ignored info' },
    ];
    const catalogWarnings = [
      { provider: 'find', code: 'reserved-name', message: 'provider name "find" collides with a built-in subcommand; set "alias" in the server config' },
      { provider: 'exa', code: 'duplicate-provider', message: 'provider "exa" is defined more than once; the first definition is used' },
    ] as const;
    const out = renderDoctor({ config: config([], diagnostics), frameworks: [], probes: [], catalogWarnings, home: '/home/u' });
    expect(out.exitCode).toBe(2);
    expect(out.text).not.toContain('ignored info');
    await expect(`${out.text}\n`).toMatchFileSnapshot('./__snapshots__/doctor-config.txt');

    const warningsOnly = renderDoctor({ config: config([], diagnostics.slice(0, 1)), frameworks: [], probes: [], catalogWarnings });
    expect(warningsOnly.exitCode).toBe(0);
  });

  describe('secrets', () => {
    it('reports literal credentials in env, headers and auth by name and file, never the value', async () => {
      const servers = [
        server('exa', {
          origin: cursorOrigin,
          transport: { type: 'stdio', command: 'npx', args: [], env: { EXA_API_KEY: FAKE_SECRET, EXA_BASE_URL: NOT_A_CREDENTIAL, REGION: 'us' } },
        }),
        server('remote', {
          origin: { scope: 'framework-project', path: '/work/repo/.mcp.json', framework: 'claude-code' },
          transport: { type: 'http', url: 'https://r.example.com/mcp', headers: { Authorization: FAKE_SECRET, 'X-Trace': 'abc' } },
        }),
        server('gw', { auth: { type: 'bearer', bearer: FAKE_SECRET } }),
        server('safe', {
          transport: { type: 'stdio', command: 'x', args: [], env: { API_TOKEN: 'env:SAFE_TOKEN', DB_PASSWORD: 'keychain:via/db', OTHER_KEY: 'file:~/.k' } },
          auth: { type: 'bearer', bearer: 'env:SAFE_BEARER' },
        }),
      ];
      const diagnostics: LoadedConfig['diagnostics'] = [
        { level: 'warning', code: 'plaintext-credential', message: 'servers.gw.auth.bearer: is a literal value; use env:, file: or keychain: so the token is not stored in the config', file: '/home/u/.config/via/config.yaml', server: 'gw' },
      ];
      const out = renderDoctor({ config: config(servers, diagnostics), frameworks: [], probes: [], home: '/home/u' });
      expect(out.exitCode).toBe(0);
      expect(out.text).not.toContain(FAKE_SECRET);
      expect(out.text).not.toContain(NOT_A_CREDENTIAL);
      expect(out.text).not.toContain('safe:');
      await expect(`${out.text}\n`).toMatchFileSnapshot('./__snapshots__/doctor-secrets.txt');
    });

    it('does not repeat the loader\'s plaintext warning under config:', () => {
      const diagnostics: LoadedConfig['diagnostics'] = [
        { level: 'warning', code: 'plaintext-credential', message: 'servers.gw.auth.bearer: is a literal value', file: '/c.yaml', server: 'gw' },
      ];
      const out = renderDoctor({ config: config([server('gw', { auth: { type: 'bearer', bearer: FAKE_SECRET } })], diagnostics), frameworks: [], probes: [] });
      expect(out.text).not.toContain('config:');
      expect(out.text.match(/gw: auth\.bearer/g)).toHaveLength(1);
    });

    it('reports auth literals even when the loader did not', () => {
      const out = renderDoctor({
        config: config([server('gw', { auth: { type: 'headers', headers: { 'X-Api-Key': FAKE_SECRET } } })]),
        frameworks: [],
        probes: [],
      });
      expect(out.text).toContain('gw: X-Api-Key is plaintext');
      expect(out.text).not.toContain(FAKE_SECRET);
    });
  });

  it('works end to end on a real loaded config', async () => {
    const tree = makeTree({
      'home/.cursor/mcp.json': JSON.stringify({
        mcpServers: { exa: { command: 'npx', args: ['-y', 'exa-mcp'], env: { EXA_API_KEY: FAKE_SECRET } }, docs: { url: 'https://docs.example.com/mcp' } },
      }),
      'project/.mcp.json': JSON.stringify({ mcpServers: { local: { command: 'node', args: ['srv.js'] } } }),
      'home/.config/via/config.yaml': 'servers:\n  docs:\n    auth: oauth\n  gw:\n    url: https://gw.example.com/mcp\n    auth: { bearer: "' + FAKE_SECRET + '" }\n',
    });
    const loaded = await tree.load();
    const probes = loaded.servers.map((s) =>
      s.name === 'docs' ? probe(s.name, { status: 'needs-auth', schemaBytes: 8000 })
      : s.name === 'local' ? probe(s.name, { status: 'untrusted' })
      : probe(s.name, { schemaBytes: 24_000 }),
    );
    const out = renderDoctor({ config: loaded, frameworks: BUNDLED_FRAMEWORKS, probes, home: tree.home });
    const text = out.text.replaceAll(tree.root, '<tmp>');
    expect(out.text).not.toContain(FAKE_SECRET);
    expect(out.exitCode).toBe(5);
    await expect(`${text}\n`).toMatchFileSnapshot('./__snapshots__/doctor-loaded.txt');
  });
});
