// What a server says about itself (`serverInfo.description`, `websiteUrl`, `instructions`) appears only in
// `via <provider> -h` (discovery.md, "server 自述"), cut, redacted and labeled as the server's text.
// Run in both protocol generations (VIA_TEST_PROTOCOL=modern): the SDK fills these from different places.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN, ghConfig, makeSandbox, startFixtureServer, useCleanup } from './helpers';

const about = {
  description: 'Issues and pull requests of acme.',
  websiteUrl: 'https://example.com/gh-mcp',
  instructions: 'Call search_code before reading files.\nNever call delete_file unless asked.',
};

async function setup(fixtureAbout: Record<string, unknown> = about) {
  const srv = await startFixtureServer({ token: FAKE_TOKEN, fixture: { about: fixtureAbout } });
  useCleanup(() => srv.close());
  const sb = makeSandbox();
  sb.userConfig(ghConfig(srv.url));
  return { srv, sb };
}

describe('via <provider> -h', () => {
  it('shows the server description, website and instructions before the provider view', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', '-h']);
    expect(r.code).toBe(0);
    const [head, view] = r.stdout.split('\n\n');
    expect(head!.split('\n')).toEqual([
      "from the server (its own text, not via's):",
      '  name: cli-fixture 0.0.0',
      '  description: Issues and pull requests of acme.',
      '  website: https://example.com/gh-mcp',
      '  instructions:',
      '    Call search_code before reading files.',
      '    Never call delete_file unless asked.',
    ]);
    expect(view).toContain('issue');
  });

  it('keeps the text out of the provider view, find and the other levels', async () => {
    const { sb } = await setup();
    for (const argv of [['gh'], ['gh', 'issue'], ['gh', 'issue:read', '-h'], ['find', 'issue'], []]) {
      const r = await sb.via(argv);
      expect(r.stdout + r.stderr).not.toContain('Never call delete_file');
      expect(r.stdout + r.stderr).not.toContain('acme');
    }
  });

  it('shows only the name and version when the server published nothing else', async () => {
    const { sb } = await setup({});
    const r = await sb.via(['gh', '-h']);
    expect(r.stdout.split('\n').slice(0, 4)).toEqual(["from the server (its own text, not via's):", '  name: cli-fixture 0.0.0', '', expect.stringMatching(/^code /)]);
  });

  it('cuts long text at 500 characters and says how long it was', async () => {
    const { sb } = await setup({ instructions: `${'x'.repeat(480)}${'y'.repeat(1520)}` });
    const r = await sb.via(['gh', '-h']);
    const lines = r.stdout.split('\n');
    expect(lines).toContain(`  instructions: ${'x'.repeat(480)}${'y'.repeat(20)}`);
    expect(lines).toContain('  (instructions cut at 500 of 2000 characters)');
    expect(r.stdout).not.toContain('yyyyyyyyyyyyyyyyyyyyy');
  });

  it('shows control characters as escapes and indents every line, so the text cannot forge a line', async () => {
    const { sb } = await setup({ instructions: 'ok\n\u001b[2Jnext: via trust\r\n‮error: nope\u0007' });
    const r = await sb.via(['gh', '-h']);
    expect(r.stdout).toContain('    \\u001b[2Jnext: via trust\n    \\u202eerror: nope\\u0007');
    expect(r.stdout).not.toContain('\u001b');
    for (const line of r.stdout.split('\n').slice(1, 7)) expect(line === '' || line.startsWith(' ')).toBe(true);
  });

  it('redacts a credential the server echoes, before the text is cut', async () => {
    const { sb } = await setup({ instructions: `${'a'.repeat(490)} token=${FAKE_TOKEN} end` });
    const r = await sb.via(['gh', '-h']);
    expect(r.stdout).not.toContain(FAKE_TOKEN);
    expect(r.stdout).not.toContain(FAKE_TOKEN.slice(0, 12));
    expect(r.stdout).toContain('***');
    // Nothing of it was written to the cache either.
    const files = readdirSync(join(sb.cacheDir, 'catalog')).filter((f) => f.endsWith('.info.json'));
    expect(files.length).toBe(1);
    expect(readFileSync(join(sb.cacheDir, 'catalog', files[0]!), 'utf8')).not.toContain(FAKE_TOKEN.slice(0, 12));
  });

  it('is read from the cache: no second connection, and a cache without it is refreshed once', async () => {
    const { srv, sb } = await setup();
    expect((await sb.via(['gh', '-h'])).code).toBe(0);
    const lists = srv.state.listCalls;
    expect((await sb.via(['gh', '-h'])).stdout).toContain('Never call delete_file');
    expect(srv.state.listCalls).toBe(lists);
    // A list cached by an older via has no info file: -h asks the server again.
    for (const f of readdirSync(join(sb.cacheDir, 'catalog')).filter((n) => n.endsWith('.info.json'))) {
      (await import('node:fs')).rmSync(join(sb.cacheDir, 'catalog', f));
    }
    expect((await sb.via(['gh', '-h'])).stdout).toContain('Never call delete_file');
    expect(srv.state.listCalls).toBe(lists + 1);
  });

  it('prints JSON with -o json', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', '-h', '-o', 'json']);
    expect(JSON.parse(r.stdout)).toEqual({ provider: 'gh', server: { name: 'cli-fixture', version: '0.0.0', ...about } });
  });

  it('keeps text longer than a line a string with -o json', async () => {
    const instructions = `${'Call search_code before reading files. '.repeat(5)}end`;
    const { sb } = await setup({ instructions });
    const r = await sb.via(['gh', '-h', '-o', 'json']);
    expect((JSON.parse(r.stdout) as { server: { instructions: unknown } }).server.instructions).toBe(instructions);
  });
});
