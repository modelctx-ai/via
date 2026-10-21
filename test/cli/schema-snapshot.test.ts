// `--schema-snapshot <file>` (arguments.md, "schema 快照校验"; cli.md, "全局选项"): a call or a usage
// view is checked against a saved `-h -o json`, and nothing is sent when the tool no longer fits.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN, ghConfig, makeSandbox, startFixtureServer, useCleanup } from './helpers';

const T0 = 1_800_000_000_000;
const LATER = T0 + 10 * 60 * 1000;

async function setup() {
  const srv = await startFixtureServer({ token: FAKE_TOKEN });
  useCleanup(() => srv.close());
  const sb = makeSandbox();
  sb.userConfig(ghConfig(srv.url));
  const snapshotOf = async (tool: string, name = 'snapshot.json'): Promise<string> => {
    const r = await sb.via(['gh', tool, '-h', '-o', 'json'], { now: T0 });
    expect(r.code).toBe(0);
    return sb.write(name, r.stdout);
  };
  const tool = (rawName: string) => srv.state.tools.find((t) => t.name === rawName)!;
  return { srv, sb, snapshotOf, tool };
}

describe('-h -o json: the tool detail', () => {
  it('prints the canonical name, the original name and both schemas', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'stat:get', '-h', '-o', 'json']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    const detail = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(detail).toEqual({
      tool: 'gh stat:get',
      rawName: 'stats_get',
      description: 'Statistics',
      inputSchema: { type: 'object', properties: {}, required: [] },
      outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
    });
    const read = JSON.parse((await sb.via(['gh', 'issue:read', '-h', '-o', 'json'])).stdout) as { readOnly?: boolean };
    expect(read.readOnly).toBe(true);
    expect(JSON.parse((await sb.via(['gh', 'file:delete', '-h', '-o', 'json'])).stdout)).toMatchObject({ destructive: true });
  });
});

describe('--schema-snapshot on a call', () => {
  it('lets a call through when the tool is as it was, and sends it', async () => {
    const { srv, sb, snapshotOf } = await setup();
    const file = await snapshotOf('echo-text');
    const r = await sb.via(['gh', 'echo-text', '--message', 'hi', '--schema-snapshot', file], { now: T0 });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('echo: hi\n');
    expect(srv.state.calls.map((c) => c.name)).toEqual(['echo_text']);
    // the single-string form of via call takes it too, and = works
    const call = await sb.via(['call', 'gh/echo-text', '--message', 'again', `--schema-snapshot=${file}`], { now: T0 });
    expect(call.code).toBe(0);
  });

  it('refuses a call without sending it when a required parameter was added (exit 2)', async () => {
    const { srv, sb, snapshotOf, tool } = await setup();
    const file = await snapshotOf('echo-text');
    (tool('echo_text').inputSchema as { properties: object; required: string[] }).required.push('lang');
    Object.assign((tool('echo_text').inputSchema as { properties: object }).properties, { lang: { type: 'string' } });
    const r = await sb.via(['gh', 'echo-text', '--message', 'hi', '--lang', 'en', '--schema-snapshot', file], { now: LATER });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(
      [
        'error: gh echo-text: 1 breaking change against ' + file + ' (compatible); nothing was sent',
        '  input  --lang  new required parameter',
        'next: via gh echo-text -h -o json',
        '',
      ].join('\n'),
    );
    expect(srv.state.calls).toEqual([]);
  });

  it('reports the changes of a drifted tool as JSON with -o json', async () => {
    const { srv, sb, snapshotOf, tool } = await setup();
    const file = await snapshotOf('echo-text');
    (tool('echo_text').inputSchema as { properties: Record<string, unknown> }).properties.message = { type: 'integer' };
    const r = await sb.via(['gh', 'echo-text', '--message', '1', '--schema-snapshot', file, '-o', 'json'], { now: LATER });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stderr)).toEqual({
      error: {
        code: 2,
        message: `gh echo-text: 1 breaking change against ${file} (compatible); nothing was sent`,
        next: 'via gh echo-text -h -o json',
        details: [{ side: 'input', path: '--message', rule: 'type', message: 'type changed: string -> integer' }],
      },
    });
    expect(srv.state.calls).toEqual([]);
  });

  it('lets additions through with a warning, but strict mode refuses them', async () => {
    const { srv, sb, snapshotOf, tool } = await setup();
    const file = await snapshotOf('echo-text');
    Object.assign((tool('echo_text').inputSchema as { properties: object }).properties, { loud: { type: 'boolean' } });
    const ok = await sb.via(['gh', 'echo-text', '--message', 'hi', '--loud', '--schema-snapshot', file], { now: LATER });
    expect(ok.code).toBe(0);
    expect(ok.stderr).toContain('warning: gh echo-text changed compatibly since the snapshot: --loud new optional parameter');
    expect(srv.state.calls).toHaveLength(1);

    const strict = await sb.via(['gh', 'echo-text', '--message', 'hi', '--schema-snapshot', file, '--schema-mode', 'strict'], { now: LATER });
    expect(strict.code).toBe(2);
    expect(strict.stderr).toContain('(strict)');
    expect(strict.stderr).toContain('input  properties.loud  added: {"type":"boolean"}');
    expect(srv.state.calls).toHaveLength(1);
  });

  it('checks the output schema too', async () => {
    const { srv, sb, snapshotOf, tool } = await setup();
    const file = await snapshotOf('stats_get');
    tool('stats_get').outputSchema = { type: 'object', properties: { total: { type: 'integer' } }, required: ['total'] };
    const r = await sb.via(['gh', 'stats_get', '--schema-snapshot', file], { now: LATER });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('output  count  required field removed');
    expect(r.stderr).toContain('(1 more change that is compatible)');
    expect(srv.state.calls).toEqual([]);
  });

  it('uses the tool list as it is now when the cached one is older than five minutes, not before', async () => {
    const { srv, sb, snapshotOf, tool } = await setup();
    const file = await snapshotOf('echo-text');
    (tool('echo_text').inputSchema as { properties: Record<string, unknown> }).properties.message = { type: 'integer' };
    const cached = await sb.via(['gh', 'echo-text', '--message', 'hi', '--schema-snapshot', file], { now: T0 + 60_000 });
    expect(cached.code, 'the cache is a minute old: its schema is what is compared').toBe(0);
    const calls = srv.state.listCalls;
    const fresh = await sb.via(['gh', 'echo-text', '--message', 'hi', '--schema-snapshot', file], { now: LATER });
    expect(fresh.code).toBe(2);
    expect(srv.state.listCalls).toBe(calls + 1);
  });

  it('refuses before a dry run too, and a tool that is gone is exit 3', async () => {
    const { srv, sb, snapshotOf, tool } = await setup();
    const file = await snapshotOf('echo-text');
    (tool('echo_text').inputSchema as { properties: Record<string, unknown> }).properties.message = { type: 'integer' };
    expect((await sb.via(['gh', 'echo-text', '--message', '1', '--dry-run', '--schema-snapshot', file], { now: LATER })).code).toBe(2);
    srv.state.tools.splice(srv.state.tools.indexOf(tool('echo_text')), 1);
    const gone = await sb.via(['gh', 'echo-text', '--message', 'hi', '--schema-snapshot', file], { now: LATER + LATER - T0 });
    expect(gone.code).toBe(3);
    expect(gone.stderr).toContain('gh echo-text is no longer offered by gh');
    expect(srv.state.calls).toEqual([]);
  });
});

describe('--schema-snapshot on the usage', () => {
  it('prints the usage when the tool fits, and nothing but the report when it does not', async () => {
    const { sb, snapshotOf, tool } = await setup();
    const file = await snapshotOf('echo-text');
    const ok = await sb.via(['gh', 'echo-text', '-h', '--schema-snapshot', file], { now: T0 });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('usage: via gh echo-text --message <str>');
    (tool('echo_text').inputSchema as { properties: Record<string, unknown> }).properties.message = { type: 'integer' };
    const bad = await sb.via(['gh', 'echo-text', '-h', '--schema-snapshot', file], { now: LATER });
    expect(bad.code).toBe(2);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toContain('input  --message  type changed: string -> integer');
  });

  it('saves a snapshot that the same check accepts, for every tool of the fixture', async () => {
    const { sb, srv } = await setup();
    for (const tool of srv.state.tools) {
      const detail = await sb.via(['gh', tool.name, '-h', '-o', 'json'], { now: T0 });
      expect(detail.code, tool.name).toBe(0);
      const file = sb.write(join('snapshots', `${tool.name}.json`), detail.stdout);
      const check = await sb.via(['gh', tool.name, '-h', '--schema-snapshot', file, '--schema-mode', 'strict'], { now: T0 });
      expect(check.code, `${tool.name}: ${check.stderr}`).toBe(0);
    }
  });
});

describe('--schema-snapshot misuse', () => {
  it('is a usage error (exit 2) for a missing or unreadable file, bad JSON, a snapshot of another tool and a bad mode', async () => {
    const { sb, snapshotOf } = await setup();
    const file = await snapshotOf('echo-text');
    const missing = await sb.via(['gh', 'echo-text', '--message', 'x', '--schema-snapshot', 'nope.json']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('--schema-snapshot cannot read nope.json: no such file');
    expect(missing.stderr).toContain('next: via gh echo-text -h -o json');

    writeFileSync(join(sb.root, 'broken.json'), '{ not json');
    expect((await sb.via(['gh', 'echo-text', '-h', '--schema-snapshot', join(sb.root, 'broken.json')])).stderr).toContain('is not JSON');
    writeFileSync(join(sb.root, 'list.json'), '{"tools": []}');
    expect((await sb.via(['gh', 'echo-text', '-h', '--schema-snapshot', join(sb.root, 'list.json')])).stderr).toContain('is not a tool snapshot');

    const other = await sb.via(['gh', 'search_code', '-h', '--schema-snapshot', file]);
    expect(other.code).toBe(2);
    expect(other.stderr).toContain('is the snapshot of echo_text, not of gh code:search');

    const mode = await sb.via(['gh', 'echo-text', '-h', '--schema-snapshot', file, '--schema-mode', 'loose']);
    expect(mode.code).toBe(2);
    expect(mode.stderr).toContain('--schema-mode must be compatible or strict');
    expect((await sb.via(['gh', 'echo-text', '-h', '--schema-snapshot'])).code).toBe(2);
  });

  it('is a usage error where there is no tool to check, instead of looking like a check that passed', async () => {
    const { sb, snapshotOf } = await setup();
    const file = await snapshotOf('echo-text');
    for (const argv of [['--schema-snapshot', file], ['gh'], ['gh', 'issue'], ['servers'], ['find', 'echo'], ['batch']]) {
      const r = await sb.via(argv.includes('--schema-snapshot') ? argv : [...argv, '--schema-snapshot', file]);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.stderr, argv.join(' ')).toContain('--schema-snapshot applies to a tool call or its usage (-h)');
    }
  });

  it('does not take away tool parameters that happen to be called schema', async () => {
    const { srv, sb } = await setup();
    srv.state.tools.push(
      { name: 'db_create', description: 'Create a database', inputSchema: { type: 'object', properties: { schema: { type: 'string' } }, required: ['schema'] } },
      { name: 'db_mode', description: 'x', inputSchema: { type: 'object', properties: { 'schema-mode': { type: 'string' } }, required: ['schema-mode'] } },
    );
    const r = await sb.via(['gh', 'db_create', '--schema', 'CREATE TABLE t (id int)', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"schema": "CREATE TABLE t (id int)"');
    expect((await sb.via(['gh', 'db_create', '-h'])).stdout).toContain('--schema <str>');
    // a parameter that shares its name with one of the new options is reached with --p. like any other
    const mode = await sb.via(['gh', 'db_mode', '--p.schema-mode', 'fast', '--dry-run']);
    expect(mode.stdout).toContain('"schema-mode": "fast"');
    expect((await sb.via(['gh', 'db_mode', '-h'])).stdout).toContain('--p.schema-mode <str>');
  });
});
