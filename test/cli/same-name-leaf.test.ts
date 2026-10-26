import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN, makeSandbox, startFixtureServer, useCleanup } from './helpers';
import { loadTools } from '../helpers/fixtures';

// A leaf tool named for a resource (`secrets` for `secret`): the resource view shows it, and a
// name that does not resolve leads to it first (discovery.md, "浏览视图" and "找不到时"). The `notes`
// fixture is a server whose tools are named the way a plural provider name makes them awkward.

async function setup() {
  const srv = await startFixtureServer({ token: FAKE_TOKEN });
  useCleanup(() => srv.close());
  srv.state.tools = loadTools('other', 'notes') as typeof srv.state.tools;
  const sb = makeSandbox();
  sb.userConfig(`sources: false\nservers:\n  notes:\n    url: ${srv.url}\n    auth: { bearer: "env:GH_TOKEN" }\n`);
  return { srv, sb };
}

describe('the resource view shows the leaf tool of the same name', () => {
  it('prints it as a row after the resource tools', async () => {
    const { sb } = await setup();
    const r = await sb.via(['notes', 'secret']);
    expect(r.code).toBe(0);
    const rows = r.stdout.split('\n').filter(Boolean);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatch(/^secret:set\s/);
    expect(rows[1]).toMatch(/^secret:delete\s/);
    expect(rows[2]).toMatch(/^secrets\s.*List the names of stored secrets/);
    expect(rows[3]).toBe('→ via notes secret:<verb> -h for usage');
  });

  it('puts it in -o json as an entry without resource and verb', async () => {
    const { sb } = await setup();
    const r = await sb.via(['notes', 'note', '-o', 'json']);
    const out = JSON.parse(r.stdout) as Array<{ ref: string; resource: string | null; verb: string | null; rawName: string }>;
    expect(out.map((t) => t.ref)).toEqual([
      'notes note:create',
      'notes note:update',
      'notes note:close',
      'notes note:complete',
      'notes note:reopen',
      'notes note:search',
      'notes notes',
    ]);
    expect(out[6]).toMatchObject({ resource: null, verb: null, rawName: 'notes' });
  });
});

describe('a name that does not resolve leads to the read tool first', () => {
  it.each([
    ['note:list', 'notes notes · notes note:create · notes note:update'],
    ['note:get', 'notes notes · notes note:create · notes note:update'],
    ['secret:list', 'notes secrets · notes secret:set · notes secret:delete'],
    ['secrets:list', 'notes secrets · notes secret:set · notes secret:delete'],
    ['list-notes', 'notes notes · notes note:create · notes note:update'],
    ['list-secrets', 'notes secrets · notes secret:set · notes secret:delete'],
    ['list_builds', 'notes builds · notes build:run · notes build:confirm'],
  ])('%s', async (input, candidates) => {
    const { sb } = await setup();
    const r = await sb.via(['notes', input]);
    expect(r.code).toBe(3);
    const first = candidates.split(' · ')[0]!;
    expect(r.stderr).toBe(`error: no such tool: ${input}\ndid you mean: ${candidates}\nnext: via ${first} -h\n`);
  });

  it('a word after the resource leads to it too', async () => {
    const { sb } = await setup();
    const r = await sb.via(['notes', 'secret', 'list']);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe('error: unexpected argument "list"\ndid you mean: notes secrets\nnext: via notes secrets -h\n');
  });

  it('a typo of a verb is still answered with that verb', async () => {
    const { sb } = await setup();
    const r = await sb.via(['notes', 'note:updat']);
    expect(r.stderr).toBe('error: no such tool: note:updat\ndid you mean: notes note:update\nnext: via notes note:update -h\n');
  });
});
