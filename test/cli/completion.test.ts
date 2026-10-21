// `--complete <argument>` on `via prompts <provider> <name>` and `via resources <provider> <template>`
// (cli.md, "补全"): the server's `completion/complete` suggestions for one argument, given the others as context.
import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN, ghConfig, makeSandbox, startFixtureServer, useCleanup } from './helpers';

async function setup(features: Array<'resources' | 'prompts' | 'completions'> = ['resources', 'prompts', 'completions']) {
  const srv = await startFixtureServer({ token: FAKE_TOKEN, features });
  useCleanup(() => srv.close());
  const sb = makeSandbox();
  sb.userConfig(ghConfig(srv.url));
  return { srv, sb };
}

const TEMPLATE = 'file:///project/logs/{date}.log';

describe('via prompts <provider> <name> --complete', () => {
  it('lists the values the server suggests, one per line', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['prompts', 'gh', 'review', '--complete', 'lang']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('python\npytorch\nperl\nrust\nruby\ngo\n');
    expect(r.stderr).toMatch(/^· prompts gh review · \d+ms · 33 bytes\n$/);
    expect(srv.state.completions).toEqual([{ ref: { type: 'ref/prompt', name: 'review' }, argument: { name: 'lang', value: '' } }]);
  });

  it('takes the value already typed for that argument as the prefix and the others as context', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['prompts', 'gh', 'review', '--code', 'x = 1', '--lang', 'py', '--complete', 'lang']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('python\npytorch\n');
    expect(srv.state.completions).toEqual([{ ref: { type: 'ref/prompt', name: 'review' }, argument: { name: 'lang', value: 'py' }, context: { code: 'x = 1' } }]);
  });

  it('does not need the required arguments to be present', async () => {
    const { sb } = await setup();
    expect((await sb.via(['prompts', 'gh', 'review', '--complete=lang'])).code).toBe(0);
  });

  it('prints (no suggestions) when there are none, and JSON with -o json', async () => {
    const { sb } = await setup();
    expect((await sb.via(['prompts', 'gh', 'review', '--lang', 'zzz', '--complete', 'lang'])).stdout).toBe('(no suggestions)\n');
    const json = await sb.via(['prompts', 'gh', 'review', '--lang', 'ru', '--complete', 'lang', '-o', 'json']);
    expect(JSON.parse(json.stdout)).toEqual({ values: ['rust', 'ruby'], total: 2, hasMore: false });
  });

  it('refuses an argument the prompt does not have, listing the ones it has', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['prompts', 'gh', 'review', '--complete', 'nope']);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe('error: prompt review has no argument nope\narguments: code · lang\nnext: via prompts gh review -h\n');
    expect(srv.state.completions).toEqual([]);
  });

  it('refuses a server that did not declare completions, without sending a request', async () => {
    const { srv, sb } = await setup(['prompts']);
    const r = await sb.via(['prompts', 'gh', 'review', '--complete', 'lang']);
    expect(r.code).toBe(3);
    expect(r.stderr).toBe('error: gh does not offer MCP argument completion\nnext: via gh\n');
    expect(srv.state.completions).toEqual([]);
  });

  it('needs a prompt name', async () => {
    const { sb } = await setup();
    const r = await sb.via(['prompts', 'gh', '--complete', 'lang']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('usage: via prompts <provider> <name>');
  });

  it('is told about in the prompt -h only when the server offers completions', async () => {
    const { sb } = await setup();
    await sb.via(['sync', 'gh']);
    expect((await sb.via(['prompts', 'gh', 'review', '-h'])).stdout).toContain('complete: --complete <argument>');
    const none = await setup(['prompts']);
    await none.sb.via(['sync', 'gh']);
    expect((await none.sb.via(['prompts', 'gh', 'review', '-h'])).stdout).not.toContain('complete:');
  });
});

describe('via resources <provider> <template> --complete', () => {
  it('completes a variable of a listed template', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['resources', 'gh', TEMPLATE, '--date', '2026-10-2', '--complete', 'date']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('2026-10-20\n');
    expect(srv.state.completions).toEqual([{ ref: { type: 'ref/resource', uri: TEMPLATE }, argument: { name: 'date', value: '2026-10-2' } }]);
    expect(r.stderr).toMatch(/^· resources gh · /);
  });

  it('says when more values match than were sent', async () => {
    const { sb } = await setup();
    const r = await sb.via(['resources', 'gh', TEMPLATE, '--complete', 'date']);
    expect(r.stdout).toBe('2026-10-18\n2026-10-19\n2026-10-20\n(3 of 40 shown; more match, type more of the value)\n');
  });

  it('refuses a template the server did not list', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['resources', 'gh', 'file:///other/{x}', '--complete', 'x']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('no such resource template: file:///other/{x}');
    expect(r.stderr).toContain('next: via resources gh\n');
    expect(srv.state.completions).toEqual([]);
  });
});

describe('--complete elsewhere', () => {
  it('is a usage error, never silently ignored', async () => {
    const { sb } = await setup();
    for (const argv of [['gh', '--complete', 'x'], ['find', 'issue', '--complete', 'x'], ['--complete', 'x'], ['servers', '--complete', 'x']]) {
      const r = await sb.via(argv);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('--complete applies to via prompts');
    }
    expect((await sb.via(['prompts', 'gh', 'review', '--complete'])).stderr).toContain('--complete needs the name of an argument');
  });
});
