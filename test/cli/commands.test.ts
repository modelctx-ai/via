import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN, ghConfig, makeSandbox, normalize, startFixtureServer, useCleanup } from './helpers';


async function setup(extraConfig = '') {
  const srv = await startFixtureServer({ token: FAKE_TOKEN });
  useCleanup(() => srv.close());
  const sb = makeSandbox();
  sb.userConfig(ghConfig(srv.url, extraConfig));
  return { srv, sb };
}

describe('via servers', () => {
  it('lists servers with transport, auth status, source and notes', async () => {
    const { srv, sb } = await setup();
    sb.userConfig(
      `sources: false\nservers:\n  gh:\n    url: ${srv.url}\n    auth: { bearer: "env:GH_TOKEN" }\n  keyless:\n    url: ${srv.url}\n    auth: { bearer: "env:NOT_SET_ANYWHERE" }\n  linear:\n    auth: oauth\n    url: https://mcp.linear.example/mcp\n  off:\n    url: ${srv.url}\n    disabled: true\n  find:\n    command: node\n    args: [x.js]\n`,
    );
    sb.projectConfig('servers:\n  figma:\n    command: node\n    args: [server.js]\n');
    const r = await sb.via(['servers']);
    expect(r.code).toBe(0);
    const text = normalize(r.stdout).replaceAll(sb.root, '<root>');
    await expect(text).toMatchFileSnapshot('./__snapshots__/cli-servers.txt');
    expect(r.stdout + r.stderr).not.toContain(FAKE_TOKEN);
  });

  it('does not contact any server', async () => {
    const { srv, sb } = await setup();
    await sb.via(['servers']);
    expect(srv.state.listCalls).toBe(0);
    expect(srv.requests).toHaveLength(0);
  });

  it('shows config diagnostics even when they would stop other commands', async () => {
    const { srv, sb } = await setup();
    sb.userConfig(`${ghConfig(srv.url)}deny: ["(unclosed"]\n`);
    const r = await sb.via(['servers']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/error: .*invalid regular expression/);
  });

  it('--why explains the domain decision', async () => {
    const { sb } = await setup();
    const r = await sb.via(['servers', '--why', 'gh']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^gh → code \(heuristic, [\d.]+\)\n/);
    expect(r.stdout).toContain('next: set servers.gh.domain in ~/.config/via/config.yaml to override');
    const bad = await sb.via(['servers', '--why']);
    expect(bad.code).toBe(2);
  });
});

describe('untrusted project configuration', () => {
  it('refuses to start a project-level stdio server (exit 5) and points at via trust', async () => {
    const sb = makeSandbox();
    const marker = join(sb.root, 'started');
    sb.projectConfig(`servers:\n  evil:\n    command: touch\n    args: [${JSON.stringify(marker)}]\n`);
    const r = await sb.via(['evil']);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain('evil is defined in an untrusted project config');
    expect(r.stderr).toContain('next: via trust');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('via doctor', () => {
  it('probes every server and reports usable, needs-auth and failing ones', async () => {
    const { srv, sb } = await setup();
    sb.userConfig(
      `sources: false\nservers:\n  gh:\n    url: ${srv.url}\n    auth: { bearer: "env:GH_TOKEN" }\n  keyless:\n    url: ${srv.url}\n    auth: { bearer: "env:NOT_SET_ANYWHERE" }\n  down:\n    url: http://127.0.0.1:1/mcp\n  off:\n    url: ${srv.url}\n    disabled: true\n`,
    );
    const r = await sb.via(['doctor']);
    expect(r.code).toBe(6);
    expect(r.stdout).toContain('1 ok · 1 needs auth (keyless) · 1 failed (down) · 1 disabled (off)');
    expect(r.stdout).toMatch(/down/);
    expect(r.stdout + r.stderr).not.toContain(FAKE_TOKEN);
    expect(srv.state.listCalls).toBe(1);
  });

  it('ignores the catalog cache: it checks the connection', async () => {
    const { srv, sb } = await setup();
    await sb.via(['gh']);
    const r = await sb.via(['doctor']);
    expect(r.code).toBe(0);
    expect(srv.state.listCalls).toBe(2);
  });

  it('works with no servers at all', async () => {
    const sb = makeSandbox();
    expect((await sb.via(['doctor'])).code).toBe(0);
  });

  it('prints config errors instead of stopping, with exit 2', async () => {
    const { srv, sb } = await setup();
    sb.userConfig(`${ghConfig(srv.url)}deny: ["(unclosed"]\n`);
    const r = await sb.via(['doctor']);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('invalid regular expression');
  });
});

describe('via prompt', () => {
  it('prints the instructions and domain summary to stdout and writes no file', async () => {
    const { sb } = await setup();
    const r = await sb.via(['prompt']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('# External tools (via)');
    expect(r.stdout).toContain('gh');
    expect(r.stdout.endsWith('\n')).toBe(true);
    expect(r.stderr).toBe('');
  });

  it('--out writes the file (relative to the working directory) and keeps stdout empty', async () => {
    const { sb } = await setup();
    const r = await sb.via(['prompt', '--out', 'AGENTS.md']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(normalize(r.stderr)).toMatch(/^· wrote AGENTS\.md · \d+ bytes\n$/);
    const text = readFileSync(join(sb.project, 'AGENTS.md'), 'utf8');
    expect(text).toContain('# External tools (via)');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('--out does not replace an existing file without --yes', async () => {
    const { sb } = await setup();
    writeFileSync(join(sb.project, 'AGENTS.md'), 'my own notes\n');
    const refused = await sb.via(['prompt', '--out', 'AGENTS.md']);
    expect(refused.code).toBe(5);
    expect(readFileSync(join(sb.project, 'AGENTS.md'), 'utf8')).toBe('my own notes\n');
    const replaced = await sb.via(['prompt', '--out', 'AGENTS.md', '--yes']);
    expect(replaced.code).toBe(0);
    expect(readFileSync(join(sb.project, 'AGENTS.md'), 'utf8')).toContain('# External tools (via)');
  });
});

describe('built-ins reserved for 0.2', () => {
  it.each([['batch'], ['trust'], ['daemon', 'status']])('via %s explains itself with exit 2', async (...argv) => {
    const sb = makeSandbox();
    const r = await sb.via(argv);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^error: via \w+ .* is not available until 0\.2\n/);
    expect(r.stderr).toMatch(/next: /);
  });

  it('via trust says how the trust store works', async () => {
    const sb = makeSandbox();
    const r = await sb.via(['trust']);
    expect(r.stderr).toContain('SHA-256');
    expect(r.stderr).toContain('trust.json');
  });

  it('a server may not take a built-in name; it is skipped with a note in via servers', async () => {
    const { srv, sb } = await setup();
    sb.userConfig(`${ghConfig(srv.url)}  find:\n    url: ${srv.url}\n`);
    expect((await sb.via(['servers'])).stdout).toContain('collides with a built-in subcommand');
    const root = await sb.via([]);
    expect(root.stdout).toContain('1 provider');
  });
});

describe('help and routing', () => {
  it('-h prints the general help, a built-in name prints its usage', async () => {
    const sb = makeSandbox();
    const general = await sb.via(['-h']);
    expect(general.code).toBe(0);
    expect(general.stdout).toContain('usage:');
    expect((await sb.via(['find', '-h'])).stdout).toBe('usage: via find [<query>] [--domain <domain>] [-n <count>]\n');
    expect((await sb.via(['help', 'servers'])).stdout).toContain('via servers');
  });

  it('built-in names are matched case-insensitively', async () => {
    const sb = makeSandbox();
    expect((await sb.via(['FIND', 'x'])).stdout).toContain('no tools match "x"');
  });

  it('a provider cannot be mistaken for an option', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', '--bogus']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown option --bogus');
  });

  it('stdout and stderr stay separate: views write nothing to stderr, errors nothing to stdout', async () => {
    const { sb } = await setup();
    for (const argv of [[], ['gh'], ['gh', 'issue'], ['find', 'issue']]) {
      const r = await sb.via(argv);
      expect(r.stderr, argv.join(' ')).toBe('');
    }
    for (const argv of [['nope'], ['gh', 'nope'], ['more', 'ffff'], ['batch']]) {
      const r = await sb.via(argv);
      expect(r.stdout, argv.join(' ')).toBe('');
      expect(r.code).not.toBe(0);
    }
  });
});
