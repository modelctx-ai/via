import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN, ghConfig, makeSandbox, startFixtureServer, useCleanup } from './helpers';

// deny end to end (config.md "deny", cli.md, output.md exit code 5): hidden everywhere, refused on a direct call.

const FILE = ['gh', 'file:delete', '--owner', 'a', '--repo', 'b', '--path', 'x'];

async function setup(user = '', project?: string) {
  const srv = await startFixtureServer({ token: FAKE_TOKEN });
  useCleanup(() => srv.close());
  const sb = makeSandbox();
  sb.userConfig(ghConfig(srv.url, user));
  if (project !== undefined) sb.projectConfig(project);
  return { srv, sb };
}

describe('deny rules across layers', () => {
  it('a project config adds rules, and they apply', async () => {
    const { srv, sb } = await setup('', 'deny: ["^gh/file:delete$"]\n');
    expect((await sb.via(['gh'])).stdout).not.toContain('file:delete');
    const r = await sb.via([...FILE, '--yes']);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain('is denied by the deny rule /^gh\\/file:delete$/');
    expect(srv.state.calls).toHaveLength(0);
  });

  it('a project config cannot lift a rule of the user config', async () => {
    for (const project of ['deny: []\n', 'servers:\n  gh:\n    timeout: 5\n', 'servers:\n  gh:\n    confirm: never\n']) {
      const { srv, sb } = await setup('deny: ["^gh/file:delete$"]\n', project);
      const r = await sb.via([...FILE, '--yes']);
      expect(r.code, project).toBe(5);
      expect(srv.state.calls, project).toHaveLength(0);
    }
  });

  it('a project `deny:` with no list is a configuration error, not an empty list (fail closed)', async () => {
    const { srv, sb } = await setup('deny: ["^gh/file:delete$"]\n', 'deny:\n');
    const r = await sb.via([...FILE, '--yes']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('deny: expected list of strings');
    expect(srv.state.calls).toHaveLength(0);
  });
});

describe('deny matching on a call', () => {
  it('a rule on the raw name denies the canonical spelling and every other way in', async () => {
    const { srv, sb } = await setup('deny: ["^gh/delete_file$"]\n');
    expect((await sb.via(['find', 'delete'])).stdout).not.toContain('file:delete');
    for (const argv of [[...FILE, '--yes'], ['gh', 'delete_file', '--yes'], ['gh', 'DELETE_FILE', '--yes'], ['call', 'gh/delete_file', '--yes'], ['call', 'gh/file:delete', '--yes', '--args', '{}']]) {
      const r = await sb.via(argv);
      expect(r.code, argv.join(' ')).toBe(5);
      expect(r.stderr).toContain('is denied by the deny rule');
    }
    expect(srv.state.calls).toHaveLength(0);
  });

  it('a rule written with the provider alias matches; one written with the server name does not', async () => {
    const { sb } = await setup('    alias: tracker\ndeny: ["^tracker/file:delete$"]\n');
    expect((await sb.via(['tracker', 'file:delete', '--yes', '--owner', 'a', '--repo', 'b', '--path', 'x'])).code).toBe(5);
    const other = await setup('    alias: tracker\ndeny: ["^gh/file:delete$"]\n');
    expect((await other.sb.via(['tracker', 'file:delete', '--yes', '--owner', 'a', '--repo', 'b', '--path', 'x'])).code).toBe(0);
  });

  it('deny comes before the --yes check: a denied destructive tool is refused as denied', async () => {
    const { sb } = await setup('deny: ["^gh/file:delete$"]\n');
    const r = await sb.via(FILE);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain('is denied by the deny rule');
    expect(r.stderr).not.toContain('--yes');
  });

  it('via batch refuses a denied tool on its line (exit 5) and still runs the others', async () => {
    const { srv, sb } = await setup('deny: ["^gh/file:delete$"]\n');
    const stdin = [
      JSON.stringify({ tool: 'gh/file:delete', args: { owner: 'a', repo: 'b', path: 'x' } }),
      JSON.stringify({ tool: 'gh/issue:read', args: { owner: 'acme', repo: 'api', issue_number: 3, method: 'get' } }),
    ].join('\n');
    const r = await sb.via(['batch', '--yes'], { stdin });
    expect(r.code).toBe(5);
    expect(r.combined).toContain('is denied by the deny rule');
    expect(r.stdout).toContain('Support OAuth DCR');
    expect(srv.state.calls.map((c) => c.name)).toEqual(['issue_read']);
  });

  it('other tools stay available', async () => {
    const { sb } = await setup('deny: ["^gh/file:delete$"]\n');
    const r = await sb.via(['gh', 'issue:read', '--owner', 'acme', '--repo', 'api', '--issue-number', '3', '--method', 'get']);
    expect(r.code).toBe(0);
  });

  it('a denied tool is not offered by did-you-mean or in -o json output either', async () => {
    const { sb } = await setup('deny: ["^gh/file:delete$"]\n');
    const typo = await sb.via(['gh', 'file:delet']);
    expect(typo.code).toBe(3);
    expect(typo.stderr).not.toContain('file:delete');
    expect((await sb.via(['find', 'delete', '-o', 'json'])).stdout).not.toContain('delete_file');
  });
});
