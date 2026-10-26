// Which calls need `--yes` (arguments.md, "危险操作"; ADR 0030): the server's `destructiveHint`, via's
// reading of the tool name when the server said nothing, and the user's `confirm` rules. The tools are
// a made-up task tracker: no real server's definitions.
import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN, ghConfig, makeSandbox, startFixtureServer, useCleanup } from './helpers';

const tool = (name: string, annotations?: Record<string, boolean>) => ({
  name,
  description: `The ${name} tool`,
  ...(annotations ? { annotations } : {}),
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
});

const TASKS = [
  tool('delete_secrets'), // no hints, a destructive word: inferred
  tool('remove_label', { readOnlyHint: false }), // not read-only, no destructiveHint: inferred
  tool('list_deleted_items'), // the word is `deleted`, not `delete`
  tool('archive_task'), // no hints and no destructive word
  tool('drop_note', { destructiveHint: false }), // declared harmless: never second-guessed
  tool('purge_cache', { readOnlyHint: true }), // declared read-only: never second-guessed
  tool('wipe_disk', { destructiveHint: true }), // declared by the server
];

async function setup(extra = '', project?: string, topLevel = '') {
  const srv = await startFixtureServer({ token: FAKE_TOKEN });
  useCleanup(() => srv.close());
  srv.state.tools = TASKS;
  const sb = makeSandbox();
  sb.userConfig(`${ghConfig(srv.url, extra)}${topLevel}`);
  if (project !== undefined) sb.projectConfig(project);
  return { srv, sb };
}

const names = (calls: Array<{ name: string }>): string[] => calls.map((c) => c.name);

describe('a tool without annotations whose name says it destroys something', () => {
  it('needs --yes (exit 5, nothing sent) and the error says it was inferred', async () => {
    const { srv, sb } = await setup();
    const refused = await sb.via(['gh', 'delete_secrets']);
    expect(refused.code).toBe(5);
    expect(refused.stderr).toBe('error: gh secret:delete is destructive (inferred from its name; the server gave no hint) and was not run\nnext: rerun with --yes to confirm\n');
    expect(srv.state.calls).toHaveLength(0);
    const confirmed = await sb.via(['gh', 'delete_secrets', '--yes']);
    expect(confirmed).toMatchObject({ code: 0, stdout: 'delete_secrets: ok\n' });
  });

  it('is inferred for a tool declared not read-only that says nothing about destructiveHint', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'remove_label']);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain('is destructive (inferred from its name');
  });

  it('--dry-run succeeds and carries the requires: line, in text and JSON', async () => {
    const { srv, sb } = await setup();
    const text = await sb.via(['gh', 'delete_secrets', '--dry-run']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('requires: --yes (destructive tool, inferred from its name)');
    const json = await sb.via(['gh', 'delete_secrets', '--dry-run', '-o', 'json']);
    expect(JSON.parse(json.stdout)).toMatchObject({ dryRun: true, requires: '--yes', destructiveBy: 'inferred' });
    expect(srv.state.calls).toHaveLength(0);
  });

  it('is shown as inferred in the resource view, in find, in -h and in -o json', async () => {
    const { sb } = await setup();
    const view = await sb.via(['gh', 'secret']);
    expect(view.stdout).toMatch(/delete.*\[destructive\?\]/);
    expect((await sb.via(['gh', 'wipe_disk', '-h'])).stdout).toContain('destructive (needs --yes)');
    const help = await sb.via(['gh', 'delete_secrets', '-h']);
    expect(help.stdout).toContain('destructive? (inferred from the name; needs --yes)');
    const detail = JSON.parse((await sb.via(['gh', 'delete_secrets', '-h', '-o', 'json'])).stdout) as Record<string, unknown>;
    expect(detail).toMatchObject({ destructive: true, destructiveBy: 'inferred' });
    const found = JSON.parse((await sb.via(['find', 'delete secrets', '-o', 'json'])).stdout) as Array<Record<string, unknown>>;
    expect(found.find((t) => t.rawName === 'delete_secrets')).toMatchObject({ destructive: true, destructiveBy: 'inferred' });
  });

  it('is not inferred when the word is only part of another word, or the server declared a hint', async () => {
    const { srv, sb } = await setup();
    for (const raw of ['list_deleted_items', 'archive_task', 'drop_note', 'purge_cache']) {
      const r = await sb.via(['gh', raw]);
      expect(r, raw).toMatchObject({ code: 0, stdout: `${raw}: ok\n` });
    }
    expect(names(srv.state.calls)).toEqual(['list_deleted_items', 'archive_task', 'drop_note', 'purge_cache']);
    const detail = JSON.parse((await sb.via(['gh', 'drop_note', '-h', '-o', 'json'])).stdout) as Record<string, unknown>;
    expect(detail.destructive).toBeUndefined();
    expect(detail.destructiveBy).toBeUndefined();
  });

  it('a tool the server declared destructive keeps its old wording and is shown as declared', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'wipe_disk']);
    expect(r.stderr).toBe('error: gh wipe-disk is destructive and was not run\nnext: rerun with --yes to confirm\n');
    const detail = JSON.parse((await sb.via(['gh', 'wipe_disk', '-h', '-o', 'json'])).stdout) as Record<string, unknown>;
    expect(detail).toMatchObject({ destructive: true, destructiveBy: 'server' });
  });
});

describe('servers.<name>.confirm', () => {
  it('tools: a tool that is not destructive by itself needs --yes, and the error and views say why', async () => {
    const { srv, sb } = await setup('    confirm:\n      tools: ["archive_task$"]\n');
    const r = await sb.via(['gh', 'archive_task']);
    expect(r.code).toBe(5);
    expect(r.stderr).toBe('error: gh archive-task needs confirmation (the via config requires it) and was not run\nnext: rerun with --yes to confirm\n');
    expect(srv.state.calls).toHaveLength(0);
    expect((await sb.via(['gh', 'archive_task', '--dry-run'])).stdout).toContain('requires: --yes (confirm in the via config)');
    expect((await sb.via(['gh', 'archive_task', '-h'])).stdout).toContain('needs --yes (confirm in the via config)');
    expect((await sb.via(['gh'])).stdout).toContain('archive-task!');
    expect((await sb.via(['gh', 'archive_task', '--yes'])).code).toBe(0);
  });

  it('tools: matches the canonical form, the raw name and the leaf name like deny', async () => {
    // `list_deleted_items` splits into `deleted-item:list`; it is not destructive by itself.
    for (const pattern of ['^gh/deleted-item:list$', '^gh/list_deleted_items$', '^gh/list-deleted-items$']) {
      const { sb } = await setup(`    confirm: { tools: ["${pattern}"] }\n`);
      expect((await sb.via(['gh', 'archive_task'])).code, pattern).toBe(0);
      const listed = await sb.via(['gh', 'list_deleted_items']);
      expect(listed.code, pattern).toBe(5);
      expect(listed.stderr, pattern).toContain('needs confirmation (the via config requires it)');
    }
    // Declared harmless, but listed by the user.
    const { sb } = await setup('    confirm: { tools: ["^gh/drop-note$"] }\n');
    expect((await sb.via(['gh', 'drop_note'])).code).toBe(5);
  });

  it('except: takes the confirmation away from an inferred tool, and from a declared one', async () => {
    const { srv, sb } = await setup('    confirm:\n      except: ["delete_secrets$", "^gh/wipe-disk$"]\n');
    expect((await sb.via(['gh', 'delete_secrets'])).code).toBe(0);
    expect((await sb.via(['gh', 'wipe_disk'])).code).toBe(0);
    expect((await sb.via(['gh', 'remove_label'])).code).toBe(5);
    expect(names(srv.state.calls)).toEqual(['delete_secrets', 'wipe_disk']);
    const view = await sb.via(['gh', 'secret']);
    expect(view.stdout).not.toContain('[destructive');
  });

  it('a tool in both lists needs --yes', async () => {
    const { sb } = await setup('    confirm:\n      tools: ["delete_secrets$"]\n      except: ["delete_secrets$"]\n');
    const r = await sb.via(['gh', 'delete_secrets']);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain('needs confirmation (the via config requires it)');
  });

  it('never turns the check off for what the server declared and via inferred, not for tools', async () => {
    const { sb } = await setup('    confirm: never\n');
    expect((await sb.via(['gh', 'delete_secrets'])).code).toBe(0);
    expect((await sb.via(['gh', 'wipe_disk'])).code).toBe(0);
    const both = await setup('    confirm: never\n', 'servers:\n  gh:\n    confirm:\n      tools: ["archive_task$"]\n');
    expect((await both.sb.via(['gh', 'archive_task'])).code).toBe(5);
    expect((await both.sb.via(['gh', 'delete_secrets'])).code).toBe(0);
  });

  it('the string form destructive is still the default', async () => {
    const { sb } = await setup('    confirm: destructive\n');
    expect((await sb.via(['gh', 'delete_secrets'])).code).toBe(5);
  });

  it('a project config can add tools but cannot loosen: except and never are ignored with a warning', async () => {
    const tighter = await setup('', 'servers:\n  gh:\n    confirm:\n      tools: ["archive_task$"]\n');
    expect((await tighter.sb.via(['gh', 'archive_task'])).code).toBe(5);
    for (const project of ['servers:\n  gh:\n    confirm: never\n', 'servers:\n  gh:\n    confirm:\n      except: ["delete_secrets$"]\n']) {
      const { srv, sb } = await setup('', project);
      const r = await sb.via(['gh', 'delete_secrets']);
      expect(r.code, project).toBe(5);
      expect(srv.state.calls, project).toHaveLength(0);
      const servers = await sb.via(['doctor']);
      expect(servers.stdout + servers.stderr, project).toContain('is only read from the user config');
    }
  });

  it('the user config keeps its except when a project config adds tools', async () => {
    const { sb } = await setup('    confirm: { except: ["delete_secrets$"] }\n', 'servers:\n  gh:\n    confirm:\n      tools: ["archive_task$"]\n');
    expect((await sb.via(['gh', 'delete_secrets'])).code).toBe(0);
    expect((await sb.via(['gh', 'archive_task'])).code).toBe(5);
  });

  it('an invalid or unsafe tools pattern stops the command (fail closed); a bad except pattern only warns', async () => {
    for (const bad of ['"("', '"(a+)+$"']) {
      const { srv, sb } = await setup(`    confirm: { tools: [${bad}] }\n`);
      const r = await sb.via(['gh', 'archive_task']);
      expect(r.code, bad).toBe(2);
      expect(r.stderr, bad).toContain('servers.gh.confirm.tools[0]');
      expect(srv.state.calls).toHaveLength(0);
    }
    const { sb } = await setup('    confirm: { except: ["("] }\n');
    const r = await sb.via(['gh', 'delete_secrets']);
    expect(r.code).toBe(5);
  });

  it('a wrong shape is a configuration error', async () => {
    const { sb } = await setup('    confirm: sometimes\n');
    const r = await sb.via(['gh', 'archive_task']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('servers.gh.confirm: expected');
  });
});

describe('via batch uses the same decision', () => {
  const line = (tool: string): string => JSON.stringify({ tool, args: {} });

  it('refuses an inferred line alone, and --yes confirms it', async () => {
    const { srv, sb } = await setup();
    const stdin = `${line('gh/delete_secrets')}\n${line('gh/archive_task')}\n`;
    const refused = await sb.via(['batch'], { stdin });
    expect(refused.code).toBe(5);
    expect(refused.stdout).toBe('archive_task: ok\n');
    expect(refused.stderr).toContain('error: line 1: gh secret:delete is destructive (inferred from its name; the server gave no hint) and was not run\nnext: rerun only this line with: via batch --yes --line 1\n');
    expect(names(srv.state.calls)).toEqual(['archive_task']);
    const confirmed = await sb.via(['batch', '--yes'], { stdin });
    expect(confirmed.code).toBe(0);
    expect(names(srv.state.calls)).toEqual(['archive_task', 'delete_secrets', 'archive_task']);
  });

  it('--dry-run marks it, and a configured tool needs --yes too', async () => {
    const { srv, sb } = await setup('    confirm: { tools: ["archive_task$"] }\n');
    const r = await sb.via(['batch', '--dry-run'], { stdin: `${line('gh/delete_secrets')}\n${line('gh/archive_task')}\n${line('gh/list_deleted_items')}\n` });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('requires: --yes (destructive tool, inferred from its name)');
    expect(r.stdout).toContain('requires: --yes (confirm in the via config)');
    expect(r.stdout.match(/requires:/g)).toHaveLength(2);
    expect(srv.state.calls).toHaveLength(0);
  });
});
