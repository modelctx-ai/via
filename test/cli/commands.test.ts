import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLOCK_BEGIN, BLOCK_END, SKILL_MARKER } from '../../src/cli/prompt';
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
    expect(r.stderr).toContain('next: ask the user to run this in a terminal: via trust');
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

  it('says where the logs are, and how much they take once there are some', async () => {
    const sb = makeSandbox();
    const shown = join('~', '.cache', 'via', 'logs'); // the platform's separator, as doctor prints it
    expect((await sb.via(['doctor'])).stdout).toContain(`\nlogs      ${shown} (none yet)\n`);
    const dir = join(sb.cacheDir, 'logs');
    mkdirSync(join(dir, 'servers'), { recursive: true });
    writeFileSync(join(dir, 'daemon.log'), 'x'.repeat(2048));
    writeFileSync(join(dir, 'servers', 'gh.log'), 'x'.repeat(1024 * 1024));
    writeFileSync(join(dir, 'servers', 'gh.log.1'), 'x'.repeat(512 * 1024));
    writeFileSync(join(dir, 'servers', 'notes.txt'), 'not a log'); // only logs are counted
    const r = await sb.via(['doctor']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`\nlogs      ${shown} (3 files, 1.5 MiB)\n`);
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

describe('via prompt --skill', () => {
  const skillPath = (sb: ReturnType<typeof makeSandbox>) => join(sb.project, 'skills', 'via', 'SKILL.md');
  const read = (sb: ReturnType<typeof makeSandbox>) => readFileSync(skillPath(sb), 'utf8');
  const OUT = join('skills', 'via', 'SKILL.md');

  it('prints a SKILL.md to stdout: frontmatter, then the text of the marked block, and writes no file', async () => {
    const { sb } = await setup();
    const skill = await sb.via(['prompt', '--skill']);
    expect(skill.code).toBe(0);
    expect(skill.stderr).toBe('');
    expect(skill.stdout.startsWith('---\nname: via\ndescription: ')).toBe(true);
    expect(skill.stdout).toContain('\nallowed-tools: Bash(via:*)\n---\n\n');
    expect(skill.stdout).toContain(SKILL_MARKER);
    expect(skill.stdout).not.toContain(BLOCK_BEGIN);
    // the body is the block's text, word for word
    const block = (await sb.via(['prompt'])).stdout;
    const inner = block.slice(block.indexOf('\n\n') + 2, block.lastIndexOf('\n\n'));
    expect(skill.stdout.endsWith(`\n\n${inner}\n`)).toBe(true);
    expect(existsSync(skillPath(sb))).toBe(false);
  });

  it('--out writes the whole file where it is told to, and refreshes it on the next run', async () => {
    const { sb } = await setup();
    mkdirSync(join(sb.project, 'skills', 'via'), { recursive: true });
    const first = await sb.via(['prompt', '--skill', '--out', OUT]);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe('');
    expect(normalize(first.stderr)).toMatch(/^· wrote skills[\\/]via[\\/]SKILL\.md · \d+ bytes\n$/);
    expect(read(sb)).toBe((await sb.via(['prompt', '--skill'])).stdout);

    writeFileSync(skillPath(sb), read(sb).replace('`via more <cursor>`', '`via more <id>`'));
    const again = await sb.via(['prompt', '--skill', '--out', OUT]);
    expect(again.code).toBe(0);
    expect(normalize(again.stderr)).toMatch(/^· updated skills[\\/]via[\\/]SKILL\.md · \d+ bytes\n$/);
    expect(read(sb)).toContain('`via more <cursor>`');
  });

  it('does not make the directory, and says what to run', async () => {
    const { sb } = await setup();
    const r = await sb.via(['prompt', '--skill', '--out', OUT]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^error: cannot write skills[\\/]via[\\/]SKILL\.md: its directory does not exist\nnext: mkdir -p /);
    expect(existsSync(join(sb.project, 'skills'))).toBe(false);
  });

  it('does not overwrite a file that is not a skill written by via, unless --yes', async () => {
    const { sb } = await setup();
    mkdirSync(join(sb.project, 'skills', 'via'), { recursive: true });
    const mine = '---\nname: via\ndescription: my own notes\n---\n\nKeep this.\n';
    writeFileSync(skillPath(sb), mine);
    const refused = await sb.via(['prompt', '--skill', '--out', OUT]);
    expect(refused.code).toBe(5);
    expect(refused.stderr).toContain('is not a skill written by via prompt --skill');
    expect(refused.stderr).toContain('next: rerun with --yes to replace it');
    expect(read(sb)).toBe(mine);
    const check = await sb.via(['prompt', '--skill', '--check', OUT]);
    expect(check.code).toBe(5);
    expect(read(sb)).toBe(mine);

    const replaced = await sb.via(['prompt', '--skill', '--out', OUT, '--yes']);
    expect(replaced.code).toBe(0);
    expect(read(sb)).toContain(SKILL_MARKER);
  });

  it('--check is 0 when current, 1 when missing or out of date', async () => {
    const { sb } = await setup();
    mkdirSync(join(sb.project, 'skills', 'via'), { recursive: true });
    const missing = await sb.via(['prompt', '--skill', '--check', OUT]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('does not exist');
    expect(missing.stderr).toContain(`next: via prompt --skill --out ${OUT}`);

    await sb.via(['prompt', '--skill', '--out', OUT]);
    const ok = await sb.via(['prompt', '--skill', '--check', OUT]);
    expect(ok.code).toBe(0);
    expect(normalize(ok.stderr)).toMatch(/^· skills[\\/]via[\\/]SKILL\.md is up to date\n$/);

    writeFileSync(skillPath(sb), read(sb).replace('Providers: ', 'Providers: stale · '));
    const stale = await sb.via(['prompt', '--skill', '--check', OUT]);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain('is an out-of-date via skill');
    // the marked block is not what --skill compares: a block file is stale for it, and the other way round
    writeFileSync(join(sb.project, 'AGENTS.md'), (await sb.via(['prompt'])).stdout);
    expect((await sb.via(['prompt', '--skill', '--check', 'AGENTS.md'])).code).toBe(5);
  });

  it('--replace has no meaning with --skill', async () => {
    const { sb } = await setup();
    const r = await sb.via(['prompt', '--skill', '--out', OUT, '--replace']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--replace has no effect with --skill');
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
