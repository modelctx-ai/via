import { describe, expect, it } from 'vitest';
import { validateLayer } from '../../src/config/layer';

const messages = (raw: unknown) => validateLayer(raw, '/c.yaml').diagnostics.map((d) => `${d.level}: ${d.message}`);

describe('validateLayer', () => {
  it('accepts the full example of config.md', () => {
    const { data, diagnostics } = validateLayer(
      {
        sources: 'auto',
        servers: {
          github: { url: 'https://api.githubcopilot.com/mcp/', auth: { bearer: 'keychain:via/github' } },
          exa: { env: { EXA_API_KEY: 'env:EXA_KEY' } },
          linear: { auth: 'oauth' },
          aster: { url: 'http://127.0.0.1:3721/mcp', auth: { bearer: 'env:ASTERLANE_KEY' } },
          playwright: { exclusive: true },
          find: { alias: 'finder' },
        },
        deny: ['^github/.*:delete$'],
      },
      '/c.yaml',
    );
    expect(diagnostics).toEqual([]);
    expect(data.sources).toBe('auto');
    expect([...data.servers.keys()]).toEqual(['github', 'exa', 'linear', 'aster', 'playwright', 'find']);
    expect(data.servers.get('github')?.auth).toEqual({ type: 'bearer', bearer: 'keychain:via/github' });
    expect(data.servers.get('linear')?.auth).toEqual({ type: 'oauth' });
    expect(data.servers.get('find')).toEqual({ alias: 'finder' });
  });

  it('accepts every documented server field and output/daemon field', () => {
    const { data, diagnostics } = validateLayer(
      {
        servers: {
          s: {
            command: 'npx', args: ['-y', 8080], env: { PORT: 80 }, cwd: '/w', alias: 'a',
            rename: { list_my_issues: 'issue:list-mine' }, disabled: false, exclusive: true, confirm: 'never',
            timeout: 12.5, concurrency: 2, budget: 100, noise: ['trace_*'], auth: 'none',
          },
          h: { url: 'https://h.invalid', headers: { 'X-Key': 'env:K' }, auth: { headers: { 'X-Api-Key': 'env:K' } } },
          o: { url: 'https://o.invalid', auth: { oauth: { scopes: ['read'], clientId: 'client-1' } } },
        },
        output: { budget: 4096, cellWidth: 40 },
        daemon: { idleTimeout: 30, serverIdleTimeout: 10 },
      },
      undefined,
    );
    expect(diagnostics).toEqual([]);
    expect(data.servers.get('s')).toMatchObject({ args: ['-y', '8080'], env: { PORT: '80' }, confirm: 'never', timeout: 12.5, auth: { type: 'none' } });
    expect(data.servers.get('h')?.auth).toEqual({ type: 'headers', headers: { 'X-Api-Key': 'env:K' } });
    expect(data.servers.get('o')?.auth).toEqual({ type: 'oauth', scopes: ['read'], clientId: 'client-1' });
    expect(data.output).toEqual({ budget: 4096, cellWidth: 40 });
    expect(data.daemon).toEqual({ idleTimeout: 30, serverIdleTimeout: 10 });
  });

  it('accepts auth.oauth.clientMetadataUrl as an https URL with a path, or false; rejects anything else', () => {
    const ok = (value: unknown) => validateLayer({ servers: { o: { url: 'https://o.invalid', auth: { oauth: { clientMetadataUrl: value } } } } }, undefined);
    expect(ok('https://example.org/via/client.json').data.servers.get('o')?.auth).toEqual({ type: 'oauth', clientMetadataUrl: 'https://example.org/via/client.json' });
    expect(ok(false).data.servers.get('o')?.auth).toEqual({ type: 'oauth', clientMetadataUrl: false });
    for (const bad of ['http://example.org/c.json', 'https://example.org/', 'https://example.org', 'https://u:p@example.org/c.json', 'https://example.org/c.json#x', 'not a url']) {
      const { data, diagnostics } = ok(bad);
      expect(diagnostics.map((d) => d.message), String(bad)).toEqual(['servers.o.auth.oauth.clientMetadataUrl: expected https URL with a path (no credentials, no fragment), or false']);
      expect(data.servers.get('o')?.auth).toEqual({ type: 'oauth' });
    }
    expect(ok(true).diagnostics.map((d) => d.message)).toEqual(['servers.o.auth.oauth.clientMetadataUrl: expected non-empty string']);
  });

  it('accepts roots as paths and file URIs', () => {
    const { data, diagnostics } = validateLayer({ servers: { a: { command: 'x', roots: ['.', '~/notes', '/abs', 'C:\\work', 'file:///u', 'FILE:///v'] } } }, undefined);
    expect(diagnostics).toEqual([]);
    expect(data.servers.get('a')?.roots).toEqual(['.', '~/notes', '/abs', 'C:\\work', 'file:///u', 'FILE:///v']);
  });

  it('accepts protocolVersion when it names a known revision, and says which are known otherwise', () => {
    const ok = validateLayer({ servers: { a: { command: 'x', protocolVersion: '2026-07-28' }, b: { command: 'x', protocolVersion: '2025-03-26' } } }, undefined);
    expect(ok.diagnostics).toEqual([]);
    expect(ok.data.servers.get('a')?.protocolVersion).toBe('2026-07-28');
    expect(ok.data.servers.get('b')?.protocolVersion).toBe('2025-03-26');
    for (const bad of ['2099-01-01', 'latest', 20260728, true]) {
      const { data, diagnostics } = validateLayer({ servers: { a: { command: 'x', protocolVersion: bad } } }, undefined);
      expect(diagnostics.map((d) => d.message)).toEqual(['servers.a.protocolVersion: expected one of 2026-07-28, 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07']);
      expect(data.servers.get('a')).toEqual({ command: 'x' });
    }
  });

  it('reports type errors with the full path, and drops the bad field only', () => {
    const { data, diagnostics } = validateLayer({ servers: { github: { timeout: 'soon', url: 'https://g.invalid', concurrency: 2.5 } } }, '/c.yaml');
    expect(diagnostics.map((d) => d.message)).toEqual(['servers.github.timeout: expected number', 'servers.github.concurrency: expected positive integer']);
    expect(diagnostics[0]).toMatchObject({ level: 'error', code: 'invalid-field', file: '/c.yaml', server: 'github' });
    expect(data.servers.get('github')).toEqual({ url: 'https://g.invalid' });
  });

  it.each([
    [{ servers: { a: { timeout: -1 } } }, 'servers.a.timeout: expected positive number'],
    [{ servers: { a: { timeout: 0 } } }, 'servers.a.timeout: expected positive number'],
    [{ servers: { a: { concurrency: '4' } } }, 'servers.a.concurrency: expected positive integer'],
    [{ servers: { a: { budget: 1.5 } } }, 'servers.a.budget: expected positive integer'],
    [{ servers: { a: { disabled: 'yes' } } }, 'servers.a.disabled: expected boolean'],
    [{ servers: { a: { exclusive: 1 } } }, 'servers.a.exclusive: expected boolean'],
    [{ servers: { a: { confirm: 'sometimes' } } }, 'servers.a.confirm: expected "destructive" or "never"'],
    [{ servers: { a: { command: 5 } } }, 'servers.a.command: expected non-empty string'],
    [{ servers: { a: { url: '' } } }, 'servers.a.url: expected non-empty string'],
    [{ servers: { a: { args: 'x' } } }, 'servers.a.args: expected list of strings'],
    [{ servers: { a: { args: [['x']] } } }, 'servers.a.args[0]: expected string'],
    [{ servers: { a: { env: ['A=1'] } } }, 'servers.a.env: expected map of strings'],
    [{ servers: { a: { env: { A: { b: 1 } } } } }, 'servers.a.env.A: expected string'],
    [{ servers: { a: { rename: 'x' } } }, 'servers.a.rename: expected map of strings'],
    [{ servers: { a: { noise: 'x' } } }, 'servers.a.noise: expected list of strings'],
    [{ servers: { a: { roots: '.' } } }, 'servers.a.roots: expected list of strings'],
    [{ servers: { a: { roots: [1] } } }, 'servers.a.roots[0]: expected string'],
    [{ servers: { a: { roots: [''] } } }, 'servers.a.roots[0]: expected non-empty path or file:// URI'],
    [{ servers: { a: { roots: ['https://example.com/x'] } } }, 'servers.a.roots[0]: expected a path or file:// URI'],
    [{ servers: { a: { auth: 'basic' } } }, 'servers.a.auth: expected none, oauth, or a map with one of bearer, headers, oauth'],
    [{ servers: { a: { auth: { bearer: 'env:A', headers: {} } } } }, 'servers.a.auth: expected none, oauth, or a map with one of bearer, headers, oauth'],
    [{ servers: { a: { auth: { bearer: 5 } } } }, 'servers.a.auth.bearer: expected non-empty string'],
    [{ servers: { a: { auth: { oauth: { scopes: 'read' } } } } }, 'servers.a.auth.oauth.scopes: expected list of strings'],
    [{ servers: { a: 'nope' } }, 'servers.a: expected map'],
    [{ servers: ['a'] }, 'servers: expected map'],
    [{ deny: '^x$' }, 'deny: expected list of strings'],
    [{ deny: [1] }, 'deny[0]: expected string'],
    [{ output: { budget: 'big' } }, 'output.budget: expected positive integer'],
    [{ output: { cellWidth: 0 } }, 'output.cellWidth: expected positive integer'],
    [{ output: 5 }, 'output: expected map'],
    [{ daemon: { idleTimeout: '10m' } }, 'daemon.idleTimeout: expected number'],
    [{ daemon: { serverIdleTimeout: -5 } }, 'daemon.serverIdleTimeout: expected positive number'],
    [{ sources: 'cursor' }, 'sources: expected "auto", false, or a list of framework ids and file paths'],
    [{ sources: true }, 'sources: expected "auto", false, or a list of framework ids and file paths'],
    [{ sources: [1] }, 'sources[0]: expected string'],
  ])('%j', (raw, message) => {
    expect(messages(raw)).toEqual([`error: ${message}`]);
  });

  it('rejects a server with both command and url, and drops it', () => {
    const { data, diagnostics } = validateLayer({ servers: { a: { command: 'x', url: 'https://a.invalid' }, b: { command: 'y' } } }, undefined);
    expect(diagnostics.map((d) => [d.code, d.message])).toEqual([['invalid-server', 'servers.a: has both command and url; a server is either stdio or HTTP']]);
    expect([...data.servers.keys()]).toEqual(['b']);
  });

  it('points at the removed domain fields instead of calling them unknown', () => {
    expect(messages({ domains: { r: ['exa'] }, servers: { a: { command: 'x', domain: 'code' } } })).toEqual([
      'warning: domains: domains were removed: providers are listed as they are, delete this mapping',
      'warning: servers.a.domain: domain was removed: providers are listed as they are, delete this field',
    ]);
  });

  it('warns about unknown fields (typos) without failing', () => {
    expect(messages({ servres: {}, servers: { a: { timout: 5, command: 'x', auth: { bearer: 'env:A', extra: 1 } } }, output: { width: 1 }, daemon: { x: 1 } })).toEqual([
      'warning: servres: unknown field',
      'warning: servers.a.timout: unknown field',
      'warning: servers.a.auth.extra: unknown field',
      'warning: output.width: unknown field',
      'warning: daemon.x: unknown field',
    ]);
  });

  it('warns about literal bearer tokens and header values in auth', () => {
    expect(messages({ servers: { a: { url: 'https://a.invalid', auth: { bearer: 'fake-literal-token' } }, b: { url: 'https://b.invalid', auth: { headers: { 'X-K': 'fake-literal' } } } } })).toEqual([
      'warning: servers.a.auth.bearer: is a literal value; use env:, file: or keychain: so the token is not stored in the config',
      'warning: servers.b.auth.headers.X-K: is a literal value; use env:, file: or keychain:',
    ]);
    expect(messages({ servers: { a: { url: 'https://a.invalid', auth: { bearer: 'env:A' } } } })).toEqual([]);
  });

  it('treats an empty document and an empty server as fine, and a non-map document as one error', () => {
    expect(validateLayer(null, 'f').diagnostics).toEqual([]);
    expect(validateLayer({ servers: { a: null } }, 'f').data.servers.get('a')).toEqual({});
    expect(messages(['a'])).toEqual(['error: (root): expected a map at the top level, got list']);
    expect(messages('text')).toEqual(['error: (root): expected a map at the top level, got string']);
  });

  it('accepts sources: false and a list', () => {
    expect(validateLayer({ sources: false }, 'f').data.sources).toBe(false);
    expect(validateLayer({ sources: ['cursor', './tools/mcp.json'] }, 'f').data.sources).toEqual(['cursor', './tools/mcp.json']);
  });
});
