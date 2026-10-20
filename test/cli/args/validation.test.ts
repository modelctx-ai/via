import { describe, expect, it } from 'vitest';
import { ISSUE_LIST, FAKE_SECRET, args, failure, parse, redactFake, renderError } from './helpers';

describe('error phrasings (arguments.md, "各类错误的固定说法")', () => {
  const schema = {
    type: 'object',
    properties: {
      repo: { type: 'string' },
      count: { type: 'number' },
      state: { type: 'string', enum: ['open', 'closed', 'all'] },
      per_page: { type: 'integer', maximum: 100 },
      small: { type: 'integer', minimum: 5 },
      below: { type: 'integer', exclusiveMaximum: 10 },
      title: { type: 'string', maxLength: 256 },
      short: { type: 'string', minLength: 3 },
      id: { type: 'string', pattern: '^[A-Z]+-\\d+$' },
      labels: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      few: { type: 'array', items: { type: 'string' }, minItems: 2 },
      even: { type: 'integer', multipleOf: 2 },
      filter: { type: 'object', properties: { state: { type: 'string', enum: ['open', 'closed'] } } },
      kind: { const: 'fixed' },
    },
    required: ['repo'],
  };

  const one = async (argv: string[]) => {
    const err = await failure(schema, ['--repo', 'r', ...argv]);
    expect(err.issues).toHaveLength(1);
    return err;
  };

  it('missing required: "--repo  required"', async () => {
    const err = await failure(schema, []);
    expect(err.issues).toEqual([{ arg: '--repo', message: 'required' }]);
    expect(err.message).toBe('--repo is required');
    expect(err.details).toEqual([{ arg: '--repo', path: '/repo', rule: 'required' }]);
  });

  it('wrong type: "--count  must be a number (got "abc")"', async () => {
    expect((await one(['--count', 'abc'])).issues).toEqual([{ arg: '--count', message: 'must be a number (got "abc")' }]);
    expect((await one(['--per-page', '2.5'])).issues).toEqual([{ arg: '--per-page', message: 'must be an integer (got 2.5)' }]);
    expect((await one(['--args', '{"count":true}'])).issues[0]?.message).toBe('must be a number (got true)');
  });

  it('enum: lists the values and offers one close match', async () => {
    const err = await one(['--state', 'opened']);
    expect(err.issues).toEqual([{ arg: '--state', message: 'must be one of: open, closed, all (got "opened"; did you mean "open"?)' }]);
    expect(err.details).toEqual([
      { arg: '--state', path: '/state', rule: 'enum', expected: ['open', 'closed', 'all'], got: 'opened', suggest: 'open' },
    ]);
  });

  it('enum: no suggestion when nothing is close; case differences are suggested', async () => {
    expect((await one(['--state', 'zzz'])).issues[0]?.message).toBe('must be one of: open, closed, all (got "zzz")');
    expect((await one(['--state', 'OPEN'])).issues[0]?.message).toBe('must be one of: open, closed, all (got "OPEN"; did you mean "open"?)');
  });

  it('const uses the same phrasing as enum', async () => {
    expect((await one(['--kind', 'other'])).issues[0]?.message).toBe('must be one of: fixed (got "other")');
  });

  it('numeric ranges: "--per-page  must be <= 100 (got 500)"', async () => {
    expect((await one(['--per-page', '500'])).issues).toEqual([{ arg: '--per-page', message: 'must be <= 100 (got 500)' }]);
    expect((await one(['--small', '1'])).issues[0]?.message).toBe('must be >= 5 (got 1)');
    expect((await one(['--below', '10'])).issues[0]?.message).toBe('must be < 10 (got 10)');
    expect((await one(['--even', '3'])).issues[0]?.message).toBe('must be a multiple of 2 (got 3)');
  });

  it('string length counts characters: "--title  must be at most 256 characters (got 300)"', async () => {
    expect((await one(['--title', 'x'.repeat(300)])).issues).toEqual([{ arg: '--title', message: 'must be at most 256 characters (got 300)' }]);
    expect((await one(['--short', 'ab'])).issues[0]?.message).toBe('must be at least 3 characters (got 2)');
    expect((await one(['--short', '日本'])).issues[0]?.message).toBe('must be at least 3 characters (got 2)');
  });

  it('pattern: "--id  must match ^[A-Z]+-\\d+$ (got "eng123")"', async () => {
    expect((await one(['--id', 'eng123'])).issues).toEqual([{ arg: '--id', message: 'must match ^[A-Z]+-\\d+$ (got "eng123")' }]);
  });

  it('array length: "--labels  must have at most 10 items (got 12)"', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `l${i}`);
    expect((await one(twelve.flatMap((l) => ['--labels', l]))).issues).toEqual([{ arg: '--labels', message: 'must have at most 10 items (got 12)' }]);
    expect((await one(['--few', 'a'])).issues[0]?.message).toBe('must have at least 2 items (got 1)');
  });

  it('array element: "--labels[1]  must be a string (got 3)"', async () => {
    const err = await one(['--labels', '["a",3]']);
    expect(err.issues).toEqual([{ arg: '--labels[1]', message: 'must be a string (got 3)' }]);
    expect(err.details).toEqual([{ arg: '--labels[1]', path: '/labels/1', rule: 'type', expected: ['string'], got: 3 }]);
  });

  it('nested field: "--filter.state  must be one of: open, closed (got "x")"', async () => {
    expect((await one(['--filter.state', 'x'])).issues).toEqual([{ arg: '--filter.state', message: 'must be one of: open, closed (got "x")' }]);
  });

  it('shows arguments that came from --args with the same command-line spelling', async () => {
    const err = await failure(schema, ['--repo', 'r', '--args', '{"filter":{"state":"x"},"labels":["a",1],"per_page":500}']);
    expect(err.issues.map((i) => i.arg)).toEqual(['--per-page', '--labels[1]', '--filter.state']);
  });

  it('unknown argument: "--titel  unknown argument; did you mean --title?"', async () => {
    const err = await failure(ISSUE_LIST, ['--owner', 'o', '--repo', 'r', '--titel', 'x']);
    expect(err.issues).toEqual([{ arg: '--titel', message: 'unknown argument; did you mean --title?' }]);
    expect(err.message).toBe('unknown argument --titel; did you mean --title?');
    expect(err.details).toEqual([{ arg: '--titel', path: '/titel', rule: 'additionalProperties', suggest: '--title' }]);
  });

  it('unknown nested argument suggests the nested spelling', async () => {
    const s = { type: 'object', properties: { filter: { type: 'object', properties: { state: { type: 'string' } }, additionalProperties: false } } };
    const err = await failure(s, ['--filter.stat', 'x']);
    expect(err.issues).toEqual([{ arg: '--filter.stat', message: 'unknown argument; did you mean --filter.state?' }]);
    const viaJson = await failure(s, ['--filter', '{"stat":"x"}']);
    expect(viaJson.issues).toEqual([{ arg: '--filter.stat', message: 'unknown argument; did you mean --filter.state?' }]);
  });

  it('format mismatches are warnings, not errors', async () => {
    const s = { type: 'object', properties: { due: { type: 'string', format: 'date-time' }, mail: { type: 'string', format: 'email' } } };
    const r = await parse(s, ['--due', 'tomorrow', '--mail', 'x']);
    expect(r.args).toEqual({ due: 'tomorrow', mail: 'x' });
    expect(r.validated).toBe(true);
    expect(r.warnings).toEqual(['--due should be a date-time (got "tomorrow")', '--mail should be an email (got "x")']);
    expect((await parse(s, ['--due', '2026-10-20T10:00:00Z'])).warnings).toEqual([]);
  });

  it('a format mismatch inside an unchosen anyOf branch does not block the call', async () => {
    const s = {
      type: 'object',
      properties: { when: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'string', enum: ['now'] }] } },
    };
    expect((await parse(s, ['--when', 'now'])).args).toEqual({ when: 'now' });
  });
});

describe('collecting and formatting problems', () => {
  it('reports every problem at once, in the order of arguments.md', async () => {
    const err = await failure(ISSUE_LIST, ['--owner', 'acme', '--state', 'opened', '--per-page', '500', '--titel', 'x']);
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe('4 invalid arguments');
    expect(err.next).toBe('via acme thing:do -h');
    expect(renderError(err)).toBe(
      [
        'error: 4 invalid arguments',
        '  --repo       required',
        '  --state      must be one of: open, closed, all (got "opened"; did you mean "open"?)',
        '  --per-page   must be <= 100 (got 500)',
        '  --titel      unknown argument; did you mean --title?',
        'usage: via acme thing:do --owner <str> --repo <str> [--state open|closed|all] [--per-page <num>] [--title <str>]',
        'next: via acme thing:do -h',
      ].join('\n'),
    );
    expect(err.details).toEqual([
      { arg: '--repo', path: '/repo', rule: 'required' },
      { arg: '--state', path: '/state', rule: 'enum', expected: ['open', 'closed', 'all'], got: 'opened', suggest: 'open' },
      { arg: '--per-page', path: '/per_page', rule: 'maximum', expected: 100, got: 500 },
      { arg: '--titel', path: '/titel', rule: 'additionalProperties', suggest: '--title' },
    ]);
  });

  it('a single problem is one line followed by usage', async () => {
    const err = await failure(ISSUE_LIST, ['--owner', 'acme']);
    expect(renderError(err)).toBe(
      [
        'error: --repo is required',
        'usage: via acme thing:do --owner <str> --repo <str> [--state open|closed|all] [--per-page <num>] [--title <str>]',
      ].join('\n'),
    );
    expect(err.next).toBeUndefined();
  });

  it('truncates (got …) at 40 characters', async () => {
    const err = await failure(ISSUE_LIST, ['--owner', 'o', '--repo', 'r', '--state', 'x'.repeat(100)]);
    const got = /\(got (".*?")/.exec(err.issues[0]!.message)![1]!;
    expect(Array.from(got.slice(1, -1))).toHaveLength(40);
    expect(got.endsWith('…"')).toBe(true);
    expect((err.details[0]!.got as string).length).toBe(40);
  });

  it('replaces resolved credential values with *** before truncating', async () => {
    const s = { type: 'object', properties: { mode: { type: 'string', enum: ['a', 'b'] }, n: { type: 'integer' } } };
    const err = await failure(s, ['--mode', `${FAKE_SECRET}`, '--n', `x${FAKE_SECRET}`], { redact: redactFake });
    const text = renderError(err);
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).toContain('(got "***")');
    expect(JSON.stringify(err.details)).not.toContain(FAKE_SECRET);
    const unknown = await failure(ISSUE_LIST, ['--owner', 'o', '--repo', 'r', `--${FAKE_SECRET}`, 'v'], { redact: redactFake });
    expect(renderError(unknown)).not.toContain(FAKE_SECRET);
  });

  it('suggests at most one near value', async () => {
    const s = { type: 'object', properties: { m: { type: 'string', enum: ['read', 'reed', 'redd'] } } };
    const err = await failure(s, ['--m', 'reax']);
    expect(err.issues[0]!.message.match(/did you mean/g)).toHaveLength(1);
  });

  it('caps the optional parameters in the usage under errors and lists all values of long enums only up to a limit', async () => {
    const props = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`opt_${i}`, { type: 'string' }]));
    const s = { type: 'object', properties: { need: { type: 'string' }, ...props }, required: ['need'], additionalProperties: false };
    const err = await failure(s, []);
    const flags = err.usage.match(/\[--opt-\d+ <str>\]/g)!;
    expect(flags).toHaveLength(8);
    expect(err.usage).toContain('[…]');
    const big = { type: 'object', properties: { m: { enum: Array.from({ length: 30 }, (_, i) => `v${i}`) } } };
    expect((await failure(big, ['--m', 'zzz'])).issues[0]!.message).toBe(
      'must be one of: v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, … (18 more) (got "zzz")',
    );
  });

  it('does not repeat a required error when a type error already explains the argument', async () => {
    const s = { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['n'] };
    const err = await failure(s, ['--n', 'abc']);
    expect(err.issues).toEqual([{ arg: '--n', message: 'must be an integer (got "abc")' }]);
  });
});

describe('anyOf / oneOf mismatch', () => {
  const parent = {
    type: 'object',
    properties: {
      parent: {
        anyOf: [
          { type: 'object', properties: { page_id: { type: 'string' } }, required: ['page_id'] },
          { type: 'object', properties: { database_id: { type: 'string' } }, required: ['database_id'] },
          { type: 'object', properties: { data_source_id: { type: 'string' } }, required: ['data_source_id'] },
        ],
      },
    },
  };

  it('lists the field each branch needs instead of every branch failure', async () => {
    const err = await failure(parent, ['--parent', '{"wrong":"x"}']);
    expect(err.issues).toEqual([{ arg: '--parent', message: 'must provide one of: page_id, database_id, data_source_id' }]);
    expect(err.details).toEqual([
      { arg: '--parent', path: '/parent', rule: 'anyOf', expected: ['page_id', 'database_id', 'data_source_id'] },
    ]);
  });

  it('scalar alternatives list their types', async () => {
    const s = { type: 'object', properties: { v: { anyOf: [{ type: 'string' }, { type: 'integer' }] } } };
    expect((await failure(s, ['--args', '{"v":true}'])).issues[0]?.message).toBe('must provide one of: string, integer (got true)');
  });

  it('oneOf that matches several branches says so', async () => {
    const s = {
      type: 'object',
      properties: { v: { oneOf: [{ type: 'object', required: ['a'] }, { type: 'object', required: ['b'] }] } },
    };
    expect((await failure(s, ['--v', '{"a":1,"b":2}'])).issues[0]?.message).toBe('must provide only one of: a, b');
  });
});

describe('schema dialect and reliability (arguments.md, "校验范围" / "schema 不可靠时")', () => {
  it('uses JSON Schema 2020-12 when $schema is absent (MCP default)', async () => {
    const s = { type: 'object', properties: { pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }], items: false } } };
    expect((await failure(s, ['--pair', '["a","b"]'])).issues).toEqual([{ arg: '--pair[1]', message: 'must be an integer (got "b")' }]);
    expect((await failure(s, ['--pair', '["a",1,2]'])).issues.length).toBe(1);
    expect((await args(s, ['--pair', '["a",1]']))).toEqual({ pair: ['a', 1] });
  });

  it('honours a declared draft-07 $schema', async () => {
    const s = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { pair: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }] } },
    };
    expect((await failure(s, ['--pair', '["a","b"]'])).issues).toEqual([{ arg: '--pair[1]', message: 'must be an integer (got "b")' }]);
    expect(await args(s, ['--pair', '["a",1]'])).toEqual({ pair: ['a', 1] });
  });

  it('falls back to draft-07 for old-style schemas without $schema', async () => {
    const s = { type: 'object', properties: { pair: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }] } } };
    const r = await parse(s, ['--pair', '["a",1]']);
    expect(r.validated).toBe(true);
    expect((await failure(s, ['--pair', '["a","b"]'])).issues[0]?.arg).toBe('--pair[1]');
  });

  it('honours a declared 2020-12 $schema', async () => {
    const s = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { n: { type: 'integer' } } };
    expect((await failure(s, ['--n', 'x'])).issues[0]?.message).toBe('must be an integer (got "x")');
  });

  it('resolves internal $ref (including recursion) and does not fill in defaults', async () => {
    const s = {
      type: 'object',
      $defs: { state: { type: 'string', enum: ['open', 'closed'] }, node: { type: 'object', properties: { child: { $ref: '#/$defs/node' }, state: { $ref: '#/$defs/state' } } } },
      properties: { state: { $ref: '#/$defs/state', default: 'open' }, tree: { $ref: '#/$defs/node' } },
    };
    const ok = await parse(s, ['--tree', '{"child":{"state":"closed"}}']);
    expect(ok.args).toEqual({ tree: { child: { state: 'closed' } } });
    expect((await failure(s, ['--tree.child.state', 'nope'])).issues[0]).toEqual({
      arg: '--tree.child.state',
      message: 'must be one of: open, closed (got "nope")',
    });
  });

  it('skips external $ref parts with a warning and still validates the rest', async () => {
    const s = {
      type: 'object',
      properties: { remote: { $ref: 'https://example.com/schemas/thing.json' }, n: { type: 'integer' } },
    };
    const r = await parse(s, ['--remote', '{"x":1}', '--n', '3']);
    expect(r.args).toEqual({ remote: { x: 1 }, n: 3 });
    expect(r.validated).toBe(true);
    expect(r.warnings).toEqual(['acme thing:do: external $ref https://example.com/schemas/thing.json is not downloaded; that part is not validated']);
    expect((await failure(s, ['--n', 'x'])).issues[0]?.arg).toBe('--n');
  });

  it('an uncompilable schema is skipped with one warning and validated: false', async () => {
    const s = { type: 'object', properties: { n: { type: 'integer', minimum: 'zero' } } };
    const r = await parse(s, ['--n', '3']);
    expect(r.args).toEqual({ n: 3 });
    expect(r.validated).toBe(false);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/^schema of acme thing:do cannot be compiled \(.+\); local validation skipped$/);
    const dangling = { type: 'object', properties: { n: { $ref: '#/$defs/missing' } } };
    expect((await parse(dangling, ['--n', '3'])).validated).toBe(false);
  });

  it('--no-validate skips the schema check and reports validated: false', async () => {
    const r = await parse(ISSUE_LIST, ['--state', 'opened'], { validate: false });
    expect(r).toEqual({ args: { state: 'opened' }, warnings: [], validated: false });
  });

  it('a tool without an input schema accepts any arguments', async () => {
    const r = await parse(undefined, ['--a', '1', '--b', 'x']);
    expect(r).toEqual({ args: { a: 1, b: 'x' }, warnings: [], validated: true });
  });

  it('validates allOf / oneOf / const / additional properties maps', async () => {
    const s = {
      type: 'object',
      allOf: [{ properties: { a: { type: 'string' } }, required: ['a'] }, { properties: { b: { type: 'integer' } } }],
      properties: { labels: { type: 'object', additionalProperties: { type: 'integer' } } },
    };
    expect(await args(s, ['--a', 'x', '--b', '2', '--labels.bug', '3'])).toEqual({ a: 'x', b: 2, labels: { bug: 3 } });
    expect((await failure(s, ['--b', '2'])).issues[0]).toEqual({ arg: '--a', message: 'required' });
  });

  it('required nested fields and dependent fields use dotted spellings', async () => {
    const s = {
      type: 'object',
      properties: { filter: { type: 'object', properties: { state: { type: 'string' } }, required: ['state'] }, pages: { type: 'array', items: { type: 'object', required: ['title'] } } },
    };
    expect((await failure(s, ['--filter', '{}'])).issues).toEqual([{ arg: '--filter.state', message: 'required' }]);
    expect((await failure(s, ['--pages', '[{"title":"a"},{}]'])).issues).toEqual([{ arg: '--pages[1].title', message: 'required' }]);
  });
});

describe('missing values and unreadable bases', () => {
  const s = { type: 'object', properties: { name: { type: 'string' }, other: { type: 'string' } }, required: ['name', 'other'] };

  it('a flag without a value is reported once, not also as missing', async () => {
    const err = await failure(s, ['--other', 'x', '--name']);
    expect(err.issues).toEqual([{ arg: '--name', message: 'requires a value' }]);
    expect((await failure(s, ['--name', '--other', 'x'])).issues).toEqual([{ arg: '--name', message: 'requires a value' }]);
  });

  it('an unreadable --args does not also report every required field', async () => {
    const err = await failure(s, ['--args', '{"name":']);
    expect(err.issues.map((i) => i.arg)).toEqual(['--args']);
    const missing = await failure(s, ['--args', '@nope.json']);
    expect(missing.message).toBe('--args cannot read @nope.json: no such file');
  });
});
