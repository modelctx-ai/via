import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN, ghConfig, makeSandbox, normalize, startFixtureServer, useCleanup, type FixtureServer } from './helpers';


async function setup(extraConfig = '') {
  const srv = await startFixtureServer({ token: FAKE_TOKEN });
  useCleanup(() => srv.close());
  const sb = makeSandbox();
  sb.userConfig(ghConfig(srv.url, extraConfig));
  return { srv, sb };
}

/** Several providers behind the same fixture server. */
function manyProviders(srv: FixtureServer, names: string[]): string {
  return `sources: false\nservers:\n${names.map((n) => `  ${n}:\n    url: ${srv.url}\n    auth: { bearer: "env:GH_TOKEN" }\n`).join('')}`;
}

describe('via (root)', () => {
  it('lists one row per provider with its tool count', async () => {
    const { sb } = await setup();
    const r = await sb.via([]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    await expect(r.stdout).toMatchFileSnapshot('./__snapshots__/cli-root-flat.txt');
  });

  it('shows providers that need auth, are unreachable or untrusted instead of aborting', async () => {
    const { srv, sb } = await setup();
    sb.userConfig(
      `sources: false\nservers:\n  github:\n    url: ${srv.url}\n    auth: { bearer: "env:GH_TOKEN" }\n  linear:\n    url: ${srv.url}\n    auth: { bearer: "env:LINEAR_KEY" }\n  slack:\n    url: http://127.0.0.1:1/mcp\n  exa:\n    url: ${srv.url}\n    auth: { bearer: "env:GH_TOKEN" }\n  notion:\n    url: ${srv.url}\n    auth: { bearer: "env:GH_TOKEN" }\n  postgres:\n    url: ${srv.url}\n    auth: { bearer: "env:GH_TOKEN" }\n  playwright:\n    url: ${srv.url}\n    auth: { bearer: "env:GH_TOKEN" }\n`,
    );
    sb.projectConfig('servers:\n  figma:\n    command: node\n    args: [server.js]\n');
    const r = await sb.via([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^linear\s+needs auth$/m);
    expect(r.stdout).toMatch(/^slack\s+failed · cannot reach http:\/\/127\.0\.0\.1:1 \(network error\)$/m);
    expect(r.stdout).toMatch(/^figma\s+untrusted$/m);
    expect(r.stdout.split('\n')[0]).toMatch(/1 needs auth \(linear\).*1 failed \(slack\).*1 untrusted \(figma\)/);
    await expect(r.stdout).toMatchFileSnapshot('./__snapshots__/cli-root-statuses.txt');
  });

  it('says what to do when no server is configured', async () => {
    const sb = makeSandbox();
    const r = await sb.via([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('0 providers · 0 tools');
    expect(r.stdout).toContain('no MCP servers found');
  });
});

describe('via <provider>', () => {
  it('shows resources with their actions inline, and leaf tools', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    await expect(r.stdout).toMatchFileSnapshot('./__snapshots__/cli-provider.txt');
  });

  it('only contacts the provider that was asked for', async () => {
    const { srv, sb } = await setup();
    sb.userConfig(`${ghConfig(srv.url)}  other:\n    url: http://127.0.0.1:1/mcp\n`);
    const r = await sb.via(['gh']);
    expect(r.code).toBe(0);
  });

  it('shows signatures for a resource, with read-only and destructive tags', async () => {
    const { sb } = await setup();
    const issue = await sb.via(['gh', 'issue']);
    expect(issue.code).toBe(0);
    await expect(issue.stdout).toMatchFileSnapshot('./__snapshots__/cli-resource.txt');
    const file = await sb.via(['gh', 'file']);
    expect(file.stdout).toContain('[destructive]');
  });

  it('accepts a unique prefix and any case, and prints the canonical form on stderr', async () => {
    const { sb } = await setup();
    const exact = await sb.via(['gh', 'issue']);
    const lenient = await sb.via(['G', 'ISS']);
    expect(lenient.code).toBe(0);
    expect(lenient.stdout).toBe(exact.stdout);
    expect(lenient.stderr).toBe('· gh issue\n');
    expect(exact.stderr).toBe('');
  });

  it('truncates long resource lists and --all shows everything', async () => {
    const { srv, sb } = await setup();
    srv.state.tools = Array.from({ length: 30 }, (_, i) => ({ name: `thing${String.fromCharCode(97 + (i % 26))}${i}_get`, description: 'x', inputSchema: { type: 'object', properties: {} } }));
    const cut = await sb.via(['gh']);
    expect(cut.stdout).toMatch(/… \d+ more · via gh --all/);
    const all = await sb.via(['gh', '--all']);
    expect(all.stdout).not.toContain('more · via gh --all');
    expect(all.stdout.split('\n').length).toBeGreaterThan(cut.stdout.split('\n').length);
  });
});

describe('via find', () => {
  it('searches across providers and prefixes the provider', async () => {
    const { sb } = await setup();
    const r = await sb.via(['find', 'issue']);
    expect(r.code).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot('./__snapshots__/cli-find.txt');
  });

  it('takes -n', async () => {
    const { sb } = await setup();
    const one = await sb.via(['find', 'issue', '-n', '1']);
    expect(one.stdout.trim().split('\n')).toHaveLength(1);
    expect((await sb.via(['find', 'issue', '--domain', 'code'])).code).toBe(2);
  });

  it('rejects a bad -n and unknown options with exit 2', async () => {
    const { sb } = await setup();
    expect((await sb.via(['find', 'x', '-n', '0'])).code).toBe(2);
    const bad = await sb.via(['find', 'x', '--bogus']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('unknown option --bogus');
  });

  it('warns about providers it could not search, without failing', async () => {
    const { srv, sb } = await setup();
    sb.userConfig(`${ghConfig(srv.url)}  down:\n    url: http://127.0.0.1:1/mcp\n`);
    const r = await sb.via(['find', 'issue']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('gh issue:read');
    expect(normalize(r.stderr)).toContain('warning: 1 provider could not be searched: down');
  });
});

describe('tool help', () => {
  it('prints the tool usage on stdout and the canonical form when an alias was typed', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'issue_read', '-h']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('usage: via gh issue:read');
    expect(r.stderr).toBe('· gh issue:read\n');
  });
});
