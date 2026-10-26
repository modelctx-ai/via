// `via batch --line` (cli.md, "via batch"): run only the named lines, skip the rest, and the rerun
// hint of a refused destructive line that uses it.
import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN, ghConfig, makeSandbox, normalize, startFixtureServer, useCleanup } from './helpers';

async function setup() {
  const srv = await startFixtureServer({ token: FAKE_TOKEN });
  useCleanup(() => srv.close());
  const sb = makeSandbox();
  sb.userConfig(ghConfig(srv.url));
  return { srv, sb };
}

const call = (tool: string, args?: unknown): string => JSON.stringify(args === undefined ? { tool } : { tool, args });
const jsonl = (...lines: string[]): string => `${lines.join('\n')}\n`;
const records = (stdout: string): Array<Record<string, unknown>> =>
  stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const DELETE = call('gh/file:delete', { owner: 'a', repo: 'b', path: 'x' });
const ECHO = (m: string): string => call('gh/echo-text', { message: m });

describe('--line', () => {
  it('runs only the named lines; the others print nothing in text and count as skipped', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['batch', '--line', '3'], { stdin: jsonl(ECHO('one'), '', ECHO('three'), ECHO('four')) });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('echo: three\n');
    expect(normalize(r.stderr)).toBe('· gh echo-text · <t> · 12 bytes · line 3\n· batch · 3 calls · 1 ok · 2 skipped · 0ms\n');
    expect(srv.state.calls.map((c) => c.args)).toEqual([{ message: 'three' }]);
  });

  it('takes a comma list and repeats, and the output stays in input order', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['batch', '--line', '4,1', '--line=2'], { stdin: jsonl(ECHO('a'), ECHO('b'), ECHO('c'), ECHO('d')) });
    expect(r.stdout).toBe('echo: a\necho: b\necho: d\n');
    expect(normalize(r.stderr)).toContain('· batch · 4 calls · 3 ok · 1 skipped ·');
    expect(srv.state.calls).toHaveLength(3);
  });

  it('-o json writes {"line", "skipped": true} for the others', async () => {
    const { sb } = await setup();
    const r = await sb.via(['batch', '--line', '3', '-o', 'json'], { stdin: jsonl(ECHO('a'), '', ECHO('b'), ECHO('c')) });
    expect(r.code).toBe(0);
    const out = records(r.stdout);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ line: 1, skipped: true });
    expect(out[1]).toMatchObject({ line: 3, ok: true, exitCode: 0, tool: 'gh/echo-text' });
    expect(out[2]).toEqual({ line: 4, skipped: true });
    expect(normalize(r.stderr)).toBe('· batch · 3 calls · 1 ok · 2 skipped · 0ms\n');
  });

  it('a line that is not selected is not even parsed, and a failed selected line still counts as failed', async () => {
    const { sb } = await setup();
    const r = await sb.via(['batch', '--line', '1,3'], { stdin: jsonl(ECHO('ok'), '{not json', '{"tool":"gh/nothing-here"}') });
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('echo: ok\n');
    expect(normalize(r.stderr)).toContain('error: line 3: no such tool: nothing-here');
    expect(normalize(r.stderr)).toContain('· batch · 3 calls · 1 ok · 1 failed · 1 skipped ·');
  });

  it('the rerun hint of a refused destructive line is the command that runs just that line', async () => {
    const { srv, sb } = await setup();
    const input = jsonl(ECHO('first'), '', DELETE);
    const first = await sb.via(['batch'], { stdin: input });
    expect(first.code).toBe(5);
    expect(first.stderr).toContain('next: rerun only this line with: via batch --yes --line 3\n');
    const asJson = await sb.via(['batch', '-o', 'json'], { stdin: input });
    expect((records(asJson.stdout)[1]!.error as { next: string }).next).toBe('rerun only this line with: via batch --yes --line 3');
    const again = await sb.via(['batch', '--yes', '--line', '3'], { stdin: input });
    expect(again.code).toBe(0);
    expect(again.stdout).toBe('deleted x\n');
    expect(srv.state.calls.map((c) => c.name)).toEqual(['echo_text', 'echo_text', 'delete_file']);
  });

  it('a line number without a call (blank, or past the end) is exit 2 and nothing runs', async () => {
    const { srv, sb } = await setup();
    const input = jsonl(ECHO('a'), '', ECHO('c'));
    for (const [line, shown] of [['2', '2'], ['9', '9'], ['1,9', '9']] as const) {
      const r = await sb.via(['batch', '--line', line], { stdin: input });
      expect(r.code, line).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr, line).toBe(`error: --line ${shown}: there is no call at that line; nothing was run\nlines with a call: 1 · 3\nnext: via batch -h\n`);
    }
    expect(srv.state.calls).toHaveLength(0);
  });

  it('anything but a comma-separated list of positive integers is exit 2', async () => {
    const { sb } = await setup();
    for (const bad of ['0', 'x', '1,,2', '-1', '1.5', '']) {
      const r = await sb.via(['batch', '--line', bad], { stdin: jsonl(ECHO('a')) });
      expect(r.code, bad).toBe(2);
      expect(r.stderr, bad).toContain('error: --line must be line numbers separated by commas');
    }
    expect((await sb.via(['batch', '--line'], { stdin: jsonl(ECHO('a')) })).stderr).toContain('error: --line needs line numbers');
  });
});
