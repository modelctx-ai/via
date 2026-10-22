// `via skills <provider> [<name> [<file>]]` (cli.md, "skills"; ADR 0020): the skills extension of the stateless
// protocol, in-process; the daemon path is in test/daemon/skills.test.ts. The fixture publishes skills with
// manifests, one whose digest is wrong, one whose size is wrong, and one with a "dynamic" manifest.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN, ghConfig, makeSandbox, normalize, startFixtureServer, useCleanup } from './helpers';

async function setup(protocol: 'modern' | 'legacy' = 'modern', features: Array<'skills' | 'resources'> = ['skills']) {
  const srv = await startFixtureServer({ token: FAKE_TOKEN, features, protocol });
  useCleanup(() => srv.close());
  const sb = makeSandbox();
  sb.userConfig(ghConfig(srv.url));
  return { srv, sb };
}

describe('via skills <provider>', () => {
  it('lists the skills with their file counts and the first line of the description', async () => {
    const { sb } = await setup();
    const r = await sb.via(['skills', 'gh']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      [
        'refunds       3 files  Handle refund requests step by step.',
        'acme/billing  1 file   Acme billing.',
        'beta/billing  1 file   Beta billing.',
        'dyn           dynamic  A skill without a manifest.',
        'tampered      1 file   Content differs from its manifest.',
        'echo          1 file   Its text contains the credential the server saw.',
        'short         1 file   Size differs from its manifest.',
        '→ via skills gh <name> to read a skill · <name> <file> for one of its files',
        '',
      ]
        .join('\n'),
    );
    expect(r.stderr).toMatch(/^· skills gh · \d+ms · \d+ bytes\n$/);
  });

  it('prints the entries as the server published them with -o json', async () => {
    const { sb } = await setup();
    const parsed = JSON.parse((await sb.via(['skills', 'gh', '-o', 'json'])).stdout) as Array<{ uri: string; resources: unknown }>;
    expect(parsed.map((s) => s.uri)).toContain('skill://refunds/SKILL.md');
    expect(parsed.find((s) => s.uri === 'skill://dyn/SKILL.md')!.resources).toBe('dynamic');
  });

  it('is announced on the provider view when the server declared the extension', async () => {
    const { sb } = await setup();
    expect((await sb.via(['gh'])).stdout).toContain('also: via resources gh · via skills gh');
  });
});

describe('via skills <provider> <name> [<file>]', () => {
  it('prints SKILL.md and names the other files of the skill on stderr', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['skills', 'gh', 'refunds']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('---\nname: refunds\ndescription: Handle refund requests step by step.\n---\n# Refunds\nRead references/FORMS.md first.\n');
    expect(normalize(r.stderr)).toBe('· skills gh · <t> · 114 bytes\nfiles: references/FORMS.md · assets/pixel.png  (via skills gh refunds <file>)\n');
    expect(srv.state.skillRequests).toEqual(['skills/list', 'skills/get skill://refunds/SKILL.md', 'resources/read skill://refunds/SKILL.md']);
  });

  it('prints a supporting file, and saves a binary one like via read does', async () => {
    const { sb } = await setup();
    const text = await sb.via(['skills', 'gh', 'refunds', 'references/FORMS.md']);
    expect(text.stdout).toBe('Refund form fields:\n- order id\n- amount\n');
    expect(text.stderr).not.toContain('files:');
    const bin = await sb.via(['skills', 'gh', 'refunds', './assets/pixel.png']);
    expect(bin.code).toBe(0);
    const path = bin.stdout.trim();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).length).toBeGreaterThan(50);
  });

  it('accepts a name written leniently, a unique prefix, a path and a URI', async () => {
    const { sb } = await setup();
    for (const typed of ['REFUNDS', 'refu', 'skill://refunds/SKILL.md', 'skill://refunds', 'acme/billing']) {
      const r = await sb.via(['skills', 'gh', typed]);
      expect(r.code, typed).toBe(0);
    }
    expect((await sb.via(['skills', 'gh', 'acme/billing'])).stdout).toContain('Acme billing steps.');
  });

  it('does not pick between skills that share a name', async () => {
    const { sb } = await setup();
    const r = await sb.via(['skills', 'gh', 'billing']);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('error: ambiguous skill: billing\ncandidates: acme/billing · beta/billing\nnext: via skills gh acme/billing\n');
  });

  it('suggests names for an unknown skill, and the files of a skill for an unknown file', async () => {
    const { sb } = await setup();
    const skill = await sb.via(['skills', 'gh', 'refunsd']);
    expect(skill.code).toBe(3);
    expect(skill.stderr).toBe('error: no such skill: refunsd\ndid you mean: skills gh refunds\nnext: via skills gh\n');
    const file = await sb.via(['skills', 'gh', 'refunds', 'references/NOPE.md']);
    expect(file.code).toBe(3);
    expect(file.stderr).toContain('error: skill refunds has no file references/NOPE.md');
    expect(file.stderr).toContain('did you mean: SKILL.md · references/FORMS.md · assets/pixel.png');
  });

  it('refuses a file that leaves the skill directory', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['skills', 'gh', 'refunds', '../beta/billing/SKILL.md']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('leaves the skill\'s directory');
    expect(srv.state.skillRequests.some((q) => q.startsWith('resources/read'))).toBe(false);
  });

  it('refuses content whose digest differs from the manifest, and prints none of it', async () => {
    const { sb } = await setup();
    const r = await sb.via(['skills', 'gh', 'tampered']);
    expect(r.code).toBe(6);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^error: refused skill:\/\/tampered\/SKILL\.md: its sha256 differs from the manifest's \(sha256:[0-9a-f]{12}… expected, sha256:[0-9a-f]{12}… received\); nothing was printed\nnext: via skills gh\n$/);
  });

  it('refuses content whose size differs from the manifest', async () => {
    const { sb } = await setup();
    const r = await sb.via(['skills', 'gh', 'short']);
    expect(r.code).toBe(6);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('the manifest says 999 bytes, the server sent');
  });

  it('prints a skill with a "dynamic" manifest with a warning that it could not be checked', async () => {
    const { sb } = await setup();
    const r = await sb.via(['skills', 'gh', 'dyn']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('---\nname: dyn\ndescription: A skill without a manifest.\n---\nDynamic.\n');
    expect(r.stderr).toContain('warning: the manifest of skill dyn is "dynamic": the server publishes no sizes or digests, so SKILL.md could not be checked\n');
  });

  it('checks the bytes the server sent and redacts after: a credential in the text is replaced, not refused', async () => {
    const { sb } = await setup();
    const r = await sb.via(['skills', 'gh', 'echo']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('authorization: Bearer ***');
    expect(r.combined).not.toContain(FAKE_TOKEN);
  });

  it('prints structured data with -o json', async () => {
    const { sb } = await setup();
    const parsed = JSON.parse((await sb.via(['skills', 'gh', 'refunds', '-o', 'json'])).stdout) as { skill: { name: string; files: string[] }; file: { uri: string; text: string }; verified: boolean };
    expect(parsed.skill).toMatchObject({ name: 'refunds', files: ['SKILL.md', 'references/FORMS.md', 'assets/pixel.png'] });
    expect(parsed.file.uri).toBe('skill://refunds/SKILL.md');
    expect(parsed.verified).toBe(true);
  });
});

describe('where there are no skills', () => {
  it('says so on a server of the old protocol, without asking for the list', async () => {
    const { srv, sb } = await setup('legacy');
    const r = await sb.via(['skills', 'gh']);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/^error: gh does not offer MCP skills: it speaks MCP 20\d\d-\d\d-\d\d; skills need 2026-07-28 and the io\.modelcontextprotocol\/skills extension\nnext: via gh\n$/);
    expect(srv.state.skillRequests).toEqual([]);
    expect((await sb.via(['gh'])).stdout).not.toContain('via skills');
  });

  it('says so on a stateless server that did not declare the extension', async () => {
    const { srv, sb } = await setup('modern', ['resources']);
    const r = await sb.via(['skills', 'gh']);
    expect(r.code).toBe(3);
    expect(r.stderr).toBe('error: gh does not offer MCP skills: it did not declare the io.modelcontextprotocol/skills extension\nnext: via gh\n');
    expect(srv.state.skillRequests).toEqual([]);
  });
});

describe('usage', () => {
  it('needs a provider, takes at most a name and a file, and has no options', async () => {
    const { sb } = await setup();
    expect((await sb.via(['skills'])).stderr).toBe('error: usage: via skills <provider> [<name> [<file>]]\nnext: via skills -h\n');
    expect((await sb.via(['skills', 'gh', 'refunds', 'a', 'b'])).code).toBe(2);
    expect((await sb.via(['skills', 'gh', '--bogus'])).stderr).toContain('unknown option --bogus');
    expect((await sb.via(['skills', '-h'])).stdout).toContain('usage: via skills <provider>');
  });

  it('reserves skills as a provider name', async () => {
    const sb = makeSandbox();
    sb.userConfig('sources: false\nservers:\n  skills:\n    url: http://127.0.0.1:1/mcp\n');
    expect((await sb.via([])).stdout).toContain('0 providers');
    expect((await sb.via(['servers'])).stdout).toContain('skills');
  });
});
