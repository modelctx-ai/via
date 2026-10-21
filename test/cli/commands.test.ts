import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLOCK_BEGIN, BLOCK_END } from '../../src/cli/prompt';
import { portableTable } from '../helpers/portable';
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
    const text = portableTable(normalize(r.stdout).replaceAll(sb.root, '<root>'));
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

  it('takes no arguments', async () => {
    const { sb } = await setup();
    const bad = await sb.via(['servers', 'gh']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('via servers takes no arguments');
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
  const agents = (sb: ReturnType<typeof makeSandbox>) => join(sb.project, 'AGENTS.md');
  const read = (sb: ReturnType<typeof makeSandbox>) => readFileSync(agents(sb), 'utf8');
  const USER_NOTE = '# My agents\n\nKeep diffs small.\n';

  it('prints the marked block to stdout and writes no file', async () => {
    const { sb } = await setup();
    const r = await sb.via(['prompt']);
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith(`${BLOCK_BEGIN}\n`)).toBe(true);
    expect(r.stdout.trimEnd().endsWith(BLOCK_END)).toBe(true);
    expect(r.stdout).toContain('## External tools (via)');
    expect(r.stdout).toContain('is a CLI over the MCP servers already configured here');
    expect(r.stdout).toContain('Prefer it over MCP tools you already have');
    expect(r.stdout).toContain('gh');
    expect(r.stdout.endsWith('\n')).toBe(true);
    expect(r.stderr).toBe('');
    expect(existsSync(agents(sb))).toBe(false);
  });

  it('--out creates the file (relative to the working directory) and keeps stdout empty', async () => {
    const { sb } = await setup();
    const r = await sb.via(['prompt', '--out', 'AGENTS.md']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(normalize(r.stderr)).toMatch(/^· wrote AGENTS\.md · \d+ bytes\n$/);
    const text = read(sb);
    expect(text.startsWith(BLOCK_BEGIN)).toBe(true);
    expect(text.endsWith(`${BLOCK_END}\n`)).toBe(true);
  });

  it('--out appends to a file that has no block and keeps every user byte', async () => {
    const { sb } = await setup();
    writeFileSync(agents(sb), USER_NOTE);
    const r = await sb.via(['prompt', '--out', 'AGENTS.md']);
    expect(r.code).toBe(0);
    expect(normalize(r.stderr)).toMatch(/^· appended to AGENTS\.md · \d+ bytes\n$/);
    const text = read(sb);
    expect(text.startsWith(USER_NOTE)).toBe(true);
    expect(text).toContain(BLOCK_BEGIN);
  });

  it('--out refreshes only the block and keeps text written around it', async () => {
    const { sb } = await setup();
    writeFileSync(agents(sb), USER_NOTE);
    await sb.via(['prompt', '--out', 'AGENTS.md']);
    const first = read(sb);
    writeFileSync(agents(sb), `${first}\n## Local notes\n\nRun the tests twice.\n`);
    const r = await sb.via(['prompt', '--out', 'AGENTS.md']);
    expect(r.code).toBe(0);
    expect(normalize(r.stderr)).toMatch(/^· updated the via block in AGENTS\.md · \d+ bytes\n$/);
    const text = read(sb);
    expect(text.match(/<!-- via:begin/g)).toHaveLength(1);
    expect(text.startsWith(USER_NOTE)).toBe(true);
    expect(text.endsWith('## Local notes\n\nRun the tests twice.\n')).toBe(true);
    expect(text.replace(/\n+## Local notes[\s\S]*$/, '\n')).toBe(first);
  });

  it('refuses markers it cannot trust and leaves the file alone', async () => {
    const { sb } = await setup();
    for (const broken of [`${BLOCK_BEGIN}\nhalf a block\n`, `${BLOCK_BEGIN}\na\n${BLOCK_END}\n${BLOCK_BEGIN}\nb\n${BLOCK_END}\n`]) {
      writeFileSync(agents(sb), broken);
      const r = await sb.via(['prompt', '--out', 'AGENTS.md']);
      expect(r.code).toBe(5);
      expect(r.stderr).toContain('unusable via block');
      expect(r.stderr).toContain('fix the markers by hand');
      expect(read(sb)).toBe(broken);
    }
  });

  it('--check reports a missing or out-of-date block with exit 1, and 0 when current', async () => {
    const { sb } = await setup();
    const missing = await sb.via(['prompt', '--check', 'AGENTS.md']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('has no via block');
    expect(missing.stderr).toContain('next: via prompt --out AGENTS.md');

    await sb.via(['prompt', '--out', 'AGENTS.md']);
    const ok = await sb.via(['prompt', '--check', 'AGENTS.md']);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe('');
    expect(normalize(ok.stderr)).toBe('· AGENTS.md is up to date\n');

    writeFileSync(agents(sb), read(sb).replace('`via more <cursor>`', '`via more <id>`'));
    const stale = await sb.via(['prompt', '--check', 'AGENTS.md']);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain('has an out-of-date via block');
  });

  it('--check needs a value and cannot be combined with --out', async () => {
    const { sb } = await setup();
    expect((await sb.via(['prompt', '--check'])).code).toBe(2);
    expect((await sb.via(['prompt', '--check', 'AGENTS.md', '--out', 'AGENTS.md'])).code).toBe(2);
    expect((await sb.via(['prompt', '--replace'])).code).toBe(2);
  });

  it('--replace makes the block the whole file, and still needs --yes', async () => {
    const { sb } = await setup();
    writeFileSync(agents(sb), USER_NOTE);
    const refused = await sb.via(['prompt', '--out', 'AGENTS.md', '--replace']);
    expect(refused.code).toBe(5);
    expect(refused.stderr).toContain('already exists and was not overwritten');
    expect(read(sb)).toBe(USER_NOTE);

    const replaced = await sb.via(['prompt', '--out', 'AGENTS.md', '--replace', '--yes']);
    expect(replaced.code).toBe(0);
    const text = read(sb);
    expect(text.startsWith(BLOCK_BEGIN)).toBe(true);
    expect(text).not.toContain('Keep diffs small.');
  });
});

describe('built-in names', () => {
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
    expect((await sb.via(['find', '-h'])).stdout).toBe('usage: via find [<query>] [-n <count>]\n');
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
