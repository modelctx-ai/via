// `via batch` (cli.md, "via batch"): ordering under concurrency, per-line failures, exit codes,
// concurrency limits, the two output forms and credential redaction, against the CLI fixture server.
import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN, ghConfig, makeSandbox, normalize, startFixtureServer, useCleanup } from './helpers';

async function setup(extraServerConfig = '', topLevel = '') {
  const srv = await startFixtureServer({ token: FAKE_TOKEN });
  useCleanup(() => srv.close());
  const sb = makeSandbox();
  sb.userConfig(`${ghConfig(srv.url, extraServerConfig)}${topLevel}`);
  return { srv, sb };
}

/** One JSONL line. */
const call = (tool: string, args?: unknown): string => JSON.stringify(args === undefined ? { tool } : { tool, args });
const jsonl = (...lines: string[]): string => `${lines.join('\n')}\n`;
const READ = (n: number): string => call('gh/issue:read', { owner: 'acme', repo: 'api', issue_number: n, method: 'get' });

interface Record_ {
  line: number;
  tool?: string;
  ok: boolean;
  exitCode: number;
  result?: unknown;
  error?: { code: number; message: string; next?: string; details?: unknown[] };
  [key: string]: unknown;
}
const records = (stdout: string): Record_[] =>
  stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record_);

describe('order and concurrency', () => {
  it('prints results in input order whatever order the calls finish in', async () => {
    const { srv, sb } = await setup();
    const input = jsonl(
      call('gh/sleepy', { ms: 400, label: 'slow' }),
      call('gh/sleepy', { ms: 10, label: 'fast' }),
      call('gh/sleepy', { ms: 150, label: 'medium' }),
      call('gh/echo-text', { message: 'instant' }),
    );
    const r = await sb.via(['batch'], { stdin: input });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('rested slow\nrested fast\nrested medium\necho: instant\n');
    expect(normalize(r.stderr)).toBe(
      [
        '· gh sleepy · <t> · 12 bytes · line 1',
        '· gh sleepy · <t> · 12 bytes · line 2',
        '· gh sleepy · <t> · 14 bytes · line 3',
        '· gh echo-text · <t> · 14 bytes · line 4',
        '· batch · 4 calls · 4 ok · 0ms',
        '',
      ].join('\n'),
    );
    // They really ran together: three sleepy calls were in flight at once.
    expect(srv.state.maxInflight).toBe(3);
  });

  it('streams a result as soon as everything before it is done, and no earlier', async () => {
    const { sb } = await setup();
    const seen: string[] = [];
    // Line 1 is slow, line 2 fast: line 2 must not appear before line 1.
    const r = await sb.via(['batch'], { stdin: jsonl(call('gh/sleepy', { ms: 250, label: 'one' }), call('gh/sleepy', { ms: 5, label: 'two' })) });
    seen.push(...r.stdout.split('\n').filter(Boolean));
    expect(seen).toEqual(['rested one', 'rested two']);
  });

  it('honours the per-server concurrency limit', async () => {
    const { srv, sb } = await setup('    concurrency: 2\n');
    const lines = Array.from({ length: 6 }, (_, i) => call('gh/sleepy', { ms: 120, label: String(i) }));
    const r = await sb.via(['batch'], { stdin: jsonl(...lines) });
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n').filter(Boolean)).toEqual(['0', '1', '2', '3', '4', '5'].map((i) => `rested ${i}`));
    expect(srv.state.maxInflight).toBe(2);
  });

  it('runs up to the default server limit (4) at once', async () => {
    const { srv, sb } = await setup();
    const lines = Array.from({ length: 8 }, (_, i) => call('gh/sleepy', { ms: 120, label: String(i) }));
    expect((await sb.via(['batch'], { stdin: jsonl(...lines) })).code).toBe(0);
    expect(srv.state.maxInflight).toBe(4);
  });

  it('--concurrency caps the lines in flight across servers', async () => {
    const { srv, sb } = await setup('    concurrency: 8\n');
    const lines = Array.from({ length: 6 }, (_, i) => call('gh/sleepy', { ms: 100, label: String(i) }));
    expect((await sb.via(['batch', '--concurrency', '3'], { stdin: jsonl(...lines) })).code).toBe(0);
    expect(srv.state.maxInflight).toBe(3);
    srv.state.maxInflight = 0;
    expect((await sb.via(['batch', '--concurrency=1'], { stdin: jsonl(...lines) })).code).toBe(0);
    expect(srv.state.maxInflight).toBe(1);
  });

  it('rejects a --concurrency that is not a positive integer', async () => {
    const { srv, sb } = await setup();
    for (const value of ['0', '-2', '1.5', 'many', '']) {
      const r = await sb.via(['batch', '--concurrency', value], { stdin: jsonl(READ(1)) });
      expect(r.code, value).toBe(2);
      expect(r.stderr, value).toMatch(/^error: --concurrency must be a positive integer/);
    }
    expect((await sb.via(['batch', '--concurrency'], { stdin: jsonl(READ(1)) })).code).toBe(2);
    expect(srv.state.calls).toHaveLength(0);
  });

  it('lists each provider once however many lines use it', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['batch'], { stdin: jsonl(READ(1), READ(2), READ(3), READ(4), READ(5), READ(6)) });
    expect(r.code).toBe(0);
    expect(srv.state.listCalls).toBe(1);
    expect(srv.state.calls.map((c) => c.args.issue_number).sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('failures are per line', () => {
  it('reports each failing line and still runs the others; the exit code is the highest', async () => {
    const { srv, sb } = await setup();
    const input = jsonl(
      READ(1),
      call('gh/issue:rea', {}),
      call('gh/issue:list', { owner: 'acme' }),
      call('gh/broken-tool'),
      call('gh/echo-text', { message: 'after' }),
    );
    const r = await sb.via(['batch'], { stdin: input });
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('number: 1\ntitle: Support OAuth DCR\nstate: open\necho: after\n');
    expect(srv.state.calls.map((c) => c.name).sort()).toEqual(['broken_tool', 'echo_text', 'issue_read']);
    await expect(`${normalize(r.combined)}`).toMatchFileSnapshot('./__snapshots__/batch-text-mixed.txt');
  });

  it.each([
    ['all lines succeed', [READ(1), call('gh/echo-text', { message: 'x' })], 0],
    ['an upstream error (1)', [READ(1), call('gh/broken-tool')], 1],
    ['an argument error (2)', [READ(1), call('gh/broken-tool'), call('gh/issue:list', {})], 2],
    ['an unknown tool (3)', [call('gh/issue:list', {}), call('gh/nothing-like-it'), call('gh/broken-tool')], 3],
    ['a timeout (6) beats an unknown tool (3)', [call('gh/nothing-like-it'), call('gh/sleepy', { ms: 2000 })], 6],
  ])('exit code with %s', async (_name, lines, expected) => {
    const { sb } = await setup();
    const r = await sb.via(['batch', '--timeout', '0.3'], { stdin: jsonl(...lines) });
    expect(r.code).toBe(expected);
  });

  it('a timeout is reported on its line and the other lines are unaffected', async () => {
    const { sb } = await setup();
    const r = await sb.via(['batch', '--timeout', '0.3'], { stdin: jsonl(call('gh/sleepy', { ms: 2000 }), call('gh/echo-text', { message: 'ok' })) });
    expect(r.code).toBe(6);
    expect(r.stdout).toBe('echo: ok\n');
    expect(normalize(r.stderr)).toBe(
      ['error: line 1: gh did not answer within 0.3s', 'next: rerun with a larger --timeout', '· gh echo-text · <t> · 9 bytes · line 2', '· batch · 2 calls · 1 ok · 1 failed · 0ms', ''].join('\n'),
    );
  });

  it('a validation failure names the line, keeps the usage block and sends nothing for that line', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['batch'], { stdin: jsonl(call('gh/issue:list', { owner: 'acme', state: 'opened' })) });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(
      [
        'error: line 1: 2 invalid arguments',
        '  --repo    required',
        '  --state   must be one of: open, closed (got "opened"; did you mean "open"?)',
        'usage: via gh issue:list --owner <str> --repo <str> [--state open|closed] [--per-page <num>]',
        'next: via gh issue:list -h',
        '· batch · 1 call · 0 ok · 1 failed · 0ms',
        '',
      ].join('\n'),
    );
    expect(srv.state.calls).toHaveLength(0);
  });

  it('--no-validate skips the schema check for every line and marks the results', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['batch', '--no-validate'], { stdin: jsonl(call('gh/issue:list', { owner: 'a' })) });
    expect(r.code).toBe(0);
    expect(normalize(r.stderr)).toMatch(/^· gh issue:list · <t> · 178 bytes · unvalidated · line 1\n/);
    expect(srv.state.calls).toHaveLength(1);
  });

  it('an upstream error that the schema should have caught carries the "server disagrees" note', async () => {
    const { sb } = await setup();
    const r = await sb.via(['batch'], { stdin: jsonl(call('gh/picky-tool', { n: 3 })) });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^error: line 1: Invalid arguments: n must be even\nnote: .*schema and the server disagree.*\nnext: via gh picky-tool -h\n/);
  });
});

describe('deny and confirmation', () => {
  const DELETE = call('gh/file:delete', { owner: 'a', repo: 'b', path: 'x' });

  it('a denied tool fails its line with exit 5; the rest run', async () => {
    const { srv, sb } = await setup('', 'deny: ["^gh/file:delete$"]\n');
    const r = await sb.via(['batch', '--yes'], { stdin: jsonl(READ(1), DELETE, call('gh/delete_file', { owner: 'a', repo: 'b', path: 'y' }), READ(2)) });
    expect(r.code).toBe(5);
    expect(r.stderr).toContain('error: line 2: gh file:delete is denied by the deny rule /^gh\\/file:delete$/\nnext: via gh\n');
    expect(r.stderr).toContain('error: line 3: gh file:delete is denied by the deny rule');
    expect(srv.state.calls.map((c) => c.name)).toEqual(['issue_read', 'issue_read']);
  });

  it('a destructive tool without --yes is refused for that line only, and says how to confirm', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['batch'], { stdin: jsonl(DELETE, call('gh/echo-text', { message: 'fine' })) });
    expect(r.code).toBe(5);
    expect(r.stdout).toBe('echo: fine\n');
    expect(normalize(r.stderr)).toBe(
      [
        'error: line 1: gh file:delete is destructive and was not run',
        'next: rerun only this line with: via batch --yes',
        '· gh echo-text · <t> · 11 bytes · line 2',
        '· batch · 2 calls · 1 ok · 1 failed · 0ms',
        '',
      ].join('\n'),
    );
    expect(srv.state.calls.map((c) => c.name)).toEqual(['echo_text']);
  });

  it('--yes confirms every destructive line of the batch', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['batch', '--yes'], { stdin: jsonl(DELETE) });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('deleted x\n');
    expect(srv.state.calls).toHaveLength(1);
  });

  it('--no-validate does not bypass --yes', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['batch', '--no-validate'], { stdin: jsonl(call('gh/file:delete', {})) });
    expect(r.code).toBe(5);
    expect(srv.state.calls).toHaveLength(0);
  });

  it('--dry-run prints each call without sending any, destructive ones marked', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['batch', '--dry-run'], { stdin: jsonl(DELETE, call('gh/echo-text', { message: 'm' })) });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('tool: gh file:delete');
    expect(r.stdout).toContain('requires: --yes (destructive tool)');
    expect(r.stdout).toContain('tool: gh echo-text');
    expect(srv.state.calls).toHaveLength(0);
    const json = await sb.via(['batch', '--dry-run', '-o', 'json'], { stdin: jsonl(DELETE) });
    const [rec] = records(json.stdout);
    expect(rec).toMatchObject({ line: 1, tool: 'gh/file:delete', ok: true, result: { dryRun: true, rawName: 'delete_file', requires: '--yes', args: { path: 'x' } } });
  });

  it('a confirm: never server needs no --yes', async () => {
    const { sb } = await setup('    confirm: never\n');
    expect((await sb.via(['batch'], { stdin: jsonl(DELETE) })).code).toBe(0);
  });
});

describe('input', () => {
  it('reports a bad line with its position in the file and runs the good ones', async () => {
    const { srv, sb } = await setup();
    const input = [
      READ(1),
      '',
      '{"tool": "gh/issue:read", ',
      '[1,2]',
      '"gh/issue:read"',
      '{"args": {}}',
      '{"tool": "gh/echo-text", "arg": {}}',
      '{"tool": "gh/echo-text", "args": [1]}',
      '{"tool": "gh/echo-text", "args": {"message": 1}}',
      '{"tool": "echo-text"}',
      '{"tool": "gh/issue"}',
      '   ',
      READ(2),
      '',
    ].join('\n');
    const r = await sb.via(['batch'], { stdin: input });
    expect(r.code).toBe(2);
    expect(r.stdout.split('\n').filter((l) => l.startsWith('number')).length).toBe(2);
    expect(srv.state.calls).toHaveLength(2);
    await expect(normalize(r.stderr)).toMatchFileSnapshot('./__snapshots__/batch-text-invalid.txt');
  });

  it('exit 2 and nothing else for empty input', async () => {
    const { srv, sb } = await setup();
    for (const stdin of ['', '\n', '  \n\r\n\t\n']) {
      const r = await sb.via(['batch'], { stdin });
      expect(r.code).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/^error: no calls on stdin\n.*\nnext: via batch -h\n$/s);
    }
    expect(srv.state.listCalls).toBe(0);
  });

  it('accepts CRLF line ends and a byte order mark', async () => {
    const { sb } = await setup();
    const r = await sb.via(['batch'], { stdin: `﻿${READ(1)}\r\n${READ(2)}\r\n` });
    expect(r.code).toBe(0);
    expect(r.stdout.match(/^number: \d$/gm)).toEqual(['number: 1', 'number: 2']);
  });

  it('takes no positional arguments', async () => {
    const { sb } = await setup();
    const r = await sb.via(['batch', 'file.jsonl'], { stdin: jsonl(READ(1)) });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^error: usage: via batch/);
    expect((await sb.via(['batch', '--bogus'], { stdin: jsonl(READ(1)) })).code).toBe(2);
  });

  it('does not read @files or stdin for argument values: JSON strings are sent as written', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['batch'], { stdin: jsonl(call('gh/echo-text', { message: '@notes.md' }), call('gh/echo-text', { message: '-' })) });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('echo: @notes.md\necho: -\n');
    expect(srv.state.calls.map((c) => c.args.message)).toEqual(['@notes.md', '-']);
  });

  it('accepts a provider prefix, the raw tool name and a missing "args"', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['batch'], { stdin: jsonl(call('G/Request_Copilot_Review'), call('gh/request-copilot-review', {})) });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('requested\nrequested\n');
    expect(normalize(r.stderr)).toContain('· gh request-copilot-review · <t> · 10 bytes · line 1');
    expect(srv.state.calls).toHaveLength(2);
  });

  it('fails the whole batch, before any call, when the configuration has errors', async () => {
    const { srv, sb } = await setup('', 'deny: ["(unclosed"]\n');
    const r = await sb.via(['batch'], { stdin: jsonl(READ(1)) });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^error: invalid configuration/);
    expect(srv.state.calls).toHaveLength(0);
  });

  it('an unreachable provider fails its lines with the usual code; others are unaffected', async () => {
    const { srv, sb } = await setup();
    sb.userConfig(`${ghConfig(srv.url)}  down:\n    url: http://127.0.0.1:1/mcp\n`);
    const r = await sb.via(['batch'], { stdin: jsonl(call('down/anything'), READ(1), call('nope/x'), call('down/other')) });
    expect(r.code).toBe(6);
    expect(r.stdout).toBe('number: 1\ntitle: Support OAuth DCR\nstate: open\n');
    expect(r.stderr).toMatch(/error: line 1: cannot start down: cannot reach http:\/\/127\.0\.0\.1:1/);
    expect(r.stderr).toContain('error: line 3: no such provider: nope');
    expect(r.stderr).toMatch(/error: line 4: cannot start down/);
  });
});

describe('schema refresh', () => {
  const T0 = 1_800_000_000_000;

  it('refreshes a stale provider list once for the whole batch', async () => {
    const { srv, sb } = await setup();
    await sb.via(['gh'], { now: T0 });
    const list = srv.state.tools.find((t) => t.name === 'issue_list') as unknown as { inputSchema: { properties: { state: { enum: string[] } } } };
    list.inputSchema.properties.state.enum = ['open', 'closed', 'merged'];
    const line = call('gh/issue:list', { owner: 'a', repo: 'b', state: 'merged' });
    const r = await sb.via(['batch'], { stdin: jsonl(line, line, line), now: T0 + 10 * 60 * 1000 });
    expect(r.code).toBe(0);
    expect(srv.state.listCalls).toBe(2);
    expect(srv.state.calls).toHaveLength(3);
  });
});

describe('-o json', () => {
  it('prints one JSON record per line, in input order', async () => {
    const { sb } = await setup();
    const input = jsonl(
      call('gh/sleepy', { ms: 200, label: 'a' }),
      READ(7),
      call('gh/issue:list', { owner: 'a', repo: 'b' }),
      call('gh/nothing-like-it'),
      call('gh/issue:list', {}),
      '{"tool": ',
    );
    const r = await sb.via(['batch', '-o', 'json'], { stdin: input });
    expect(r.code).toBe(3);
    const out = records(r.stdout);
    expect(out.map((o) => o.line)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out.map((o) => o.ok)).toEqual([true, true, true, false, false, false]);
    expect(out.map((o) => o.exitCode)).toEqual([0, 0, 0, 3, 2, 2]);
    expect(out[0]).toMatchObject({ tool: 'gh/sleepy', result: 'rested a' });
    expect(out[1]).toMatchObject({ tool: 'gh/issue:read', result: { number: 7, title: 'Support OAuth DCR', state: 'open' } });
    expect(out[2]!.result).toEqual({
      items: [
        { number: 12, title: 'Support OAuth DCR', state: 'open' },
        { number: 11, title: 'Group inference too eager', state: 'open' },
        { number: 9, title: 'Windows named pipes', state: 'closed' },
      ],
    });
    expect(out[3]!.tool).toBeUndefined();
    expect(out[3]!.error).toMatchObject({ code: 3, message: 'no such tool: nothing-like-it' });
    expect(out[4]!.tool).toBe('gh/issue:list');
    expect(out[4]!.error).toMatchObject({ code: 2, message: '2 invalid arguments', next: 'via gh issue:list -h' });
    expect(out[4]!.error!.details).toEqual([
      { arg: '--owner', path: '/owner', rule: 'required' },
      { arg: '--repo', path: '/repo', rule: 'required' },
    ]);
    expect(out[5]!.error).toEqual({ code: 2, message: 'invalid JSON at column 10: unexpected end of input', next: 'via batch -h' });
    // Errors live in the records, not on stderr; stderr keeps only the summary line.
    expect(r.stderr).toBe('· batch · 6 calls · 3 ok · 3 failed · 0ms\n');
    for (const o of out) expect(typeof o.elapsedMs === 'number' || !o.ok).toBe(true);
    await expect(normalize(r.stdout).replace(/"elapsedMs":\d+/g, '"elapsedMs":0')).toMatchFileSnapshot('./__snapshots__/batch-json.txt');
  });

  it('an upstream error is an error record with the upstream text', async () => {
    const { sb } = await setup();
    const r = await sb.via(['batch', '-o', 'json'], { stdin: jsonl(call('gh/broken-tool')) });
    expect(r.code).toBe(1);
    expect(records(r.stdout)).toEqual([{ line: 1, tool: 'gh/broken-tool', ok: false, exitCode: 1, error: { code: 1, message: 'boom: the upstream failed', next: 'via gh broken-tool -h' } }]);
  });

  it('a result over the output budget is marked truncated with its cursor instead of being cut mid-JSON', async () => {
    const { sb } = await setup();
    const big = call('gh/list_pull_requests', { owner: 'a', repo: 'b' });
    const cut = records((await sb.via(['batch', '-o', 'json'], { stdin: jsonl(big) })).stdout)[0]!;
    expect(cut.ok).toBe(true);
    expect(cut.result).toBeUndefined();
    expect(cut.truncated).toBe(true);
    expect(cut.next).toMatch(/^via more [0-9a-f]{4,}$/);
    const full = records((await sb.via(['batch', '-o', 'json', '--full'], { stdin: jsonl(big) })).stdout)[0]!;
    expect(full.truncated).toBeUndefined();
    expect((full.result as unknown[]).length).toBe(300);
  });

  it('warnings are fields of the record, not stderr lines', async () => {
    const { sb } = await setup();
    const r = await sb.via(['batch', '-o', 'json'], { stdin: jsonl(call('gh/stats_get')) });
    const [rec] = records(r.stdout);
    expect(rec!.warnings).toEqual([expect.stringContaining('outputSchema')]);
    expect(r.stderr).not.toContain('warning:');
  });
});

describe('text and raw output', () => {
  it('-o raw prints the upstream content of each line', async () => {
    const { sb } = await setup();
    const r = await sb.via(['batch', '-o', 'raw'], { stdin: jsonl(READ(3)) });
    expect(r.stdout).toBe('{"number":3,"title":"Support OAuth DCR","state":"open"}\n');
    expect(normalize(r.stderr)).toContain('· gh issue:read · <t> · 56 bytes · line 1\n');
  });

  it('a truncated result keeps its cursor on its own meta line', async () => {
    const { sb } = await setup();
    const r = await sb.via(['batch'], { stdin: jsonl(call('gh/list_pull_requests', { owner: 'a', repo: 'b' }), READ(1)) });
    expect(r.code).toBe(0);
    expect(normalize(r.stderr)).toMatch(/^· gh pull-request:list · <t> · [\d.]+k\/[\d.]+k bytes · line 1 · next: via more [0-9a-f]+\n· gh issue:read/);
  });

  it('progress of a line is printed with that line, not interleaved with others', async () => {
    const { sb } = await setup();
    sb.userConfig(`sources: false\nservers:\n  job:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(new URL('../fixtures/mcp/cli-stdio-server.mjs', import.meta.url).pathname)}]\n`);
    const r = await sb.via(['batch'], { stdin: jsonl(call('job/run_job'), call('job/run_job')) });
    expect(r.code).toBe(0);
    expect(normalize(r.combined)).toBe(
      ['progress: 1/2 halfway', 'job done', '· job run · <t> · 9 bytes · line 1', 'progress: 1/2 halfway', 'job done', '· job run · <t> · 9 bytes · line 2', '· batch · 2 calls · 2 ok · 0ms', ''].join('\n'),
    );
  });
});

describe('credentials never reach the output', () => {
  const SECRET_LINES = [
    call('gh/whoami'),
    call('gh/echo-text', { message: `token=${FAKE_TOKEN}` }),
    call('gh/issue:list', { owner: FAKE_TOKEN, repo: 'r', state: FAKE_TOKEN }),
    call(`gh/${FAKE_TOKEN}`),
    call('gh/file:delete', { owner: 'a', repo: 'b', path: FAKE_TOKEN }),
    JSON.stringify({ tool: 'gh/echo-text', args: { message: 'x' }, [FAKE_TOKEN]: 1 }),
    `{"tool": "gh/echo-text", "args": {"message": "${FAKE_TOKEN}`,
  ];

  it.each(['text', 'json', 'raw'])('-o %s: credentials are replaced with *** in results and errors alike', async (format) => {
    const { sb } = await setup();
    const r = await sb.via(['batch', '-o', format], { stdin: jsonl(...SECRET_LINES) });
    expect(r.code).toBe(5);
    expect(r.combined).toContain('***');
    expect(r.combined).not.toContain(FAKE_TOKEN);
  });

  it('--dry-run masks credentials in the arguments', async () => {
    const { sb } = await setup();
    for (const format of ['text', 'json']) {
      const r = await sb.via(['batch', '--dry-run', '-o', format], { stdin: jsonl(call('gh/echo-text', { message: `t=${FAKE_TOKEN}` })) });
      expect(r.stdout).toContain('t=***');
      expect(r.combined).not.toContain(FAKE_TOKEN);
    }
  });
});
