import { describe, expect, it } from 'vitest';
import { args, failure, memoryIO, parse } from './helpers';

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    count: { type: 'number' },
    issue_number: { type: 'integer' },
    pullNumber: { type: 'integer' },
    draft: { type: 'boolean' },
    tag: { type: 'array', items: { type: 'string' } },
    nums: { type: 'array', items: { type: 'integer' } },
    filter: {
      type: 'object',
      properties: { state: { type: 'string' }, label: { type: 'string' }, per_page: { type: 'integer' }, inner: { type: 'object', properties: { deep: { type: 'string' } } } },
    },
    pages: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } } } },
    query: { type: 'string' },
  },
} as const;

describe('mapping table (arguments.md, "映射规则")', () => {
  it('string / number / integer: --name value and --name=value', async () => {
    expect(await args(schema, ['--name', 'acme', '--count', '3.5', '--issue-number=7'])).toEqual({ name: 'acme', count: 3.5, issue_number: 7 });
    expect(await args(schema, ['--name=a=b', '--count=-2'])).toEqual({ name: 'a=b', count: -2 });
  });

  it('keeps a string argument as typed, whatever it looks like', async () => {
    expect(await args(schema, ['--name', '123'])).toEqual({ name: '123' });
    expect(await args(schema, ['--name', 'true'])).toEqual({ name: 'true' });
    expect(await args(schema, ['--name', '-5'])).toEqual({ name: '-5' });
  });

  it('boolean: --flag, --no-flag and explicit values', async () => {
    expect(await args(schema, ['--draft'])).toEqual({ draft: true });
    expect(await args(schema, ['--no-draft'])).toEqual({ draft: false });
    expect(await args(schema, ['--draft=false'])).toEqual({ draft: false });
    expect(await args(schema, ['--draft', 'false', '--name', 'x'])).toEqual({ draft: false, name: 'x' });
  });

  it('scalar arrays: repeat the flag, or one JSON array; no comma splitting', async () => {
    expect(await args(schema, ['--tag', 'a', '--tag', 'b'])).toEqual({ tag: ['a', 'b'] });
    expect(await args(schema, ['--tag', '["a","b"]'])).toEqual({ tag: ['a', 'b'] });
    expect(await args(schema, ['--tag', 'a,b'])).toEqual({ tag: ['a,b'] });
    expect(await args(schema, ['--nums', '1', '--nums', '2'])).toEqual({ nums: [1, 2] });
  });

  it('a later JSON array replaces earlier repeats; repeats after a JSON array extend it', async () => {
    expect(await args(schema, ['--tag', 'a', '--tag', '["x"]'])).toEqual({ tag: ['x'] });
    expect(await args(schema, ['--tag', '["x"]', '--tag', 'b'])).toEqual({ tag: ['x', 'b'] });
  });

  it('objects: dot paths per field, or one JSON object', async () => {
    expect(await args(schema, ['--filter.state', 'open', '--filter.inner.deep', 'x'])).toEqual({ filter: { state: 'open', inner: { deep: 'x' } } });
    expect(await args(schema, ['--filter', '{"state":"open"}'])).toEqual({ filter: { state: 'open' } });
    expect(await args(schema, ['--filter.per-page', '5'])).toEqual({ filter: { per_page: 5 } });
  });

  it('object arrays: JSON only (inline or @file)', async () => {
    expect(await args(schema, ['--pages', '[{"title":"a"}]'])).toEqual({ pages: [{ title: 'a' }] });
    expect(await args(schema, ['--pages', '@pages.json'], { files: { 'pages.json': '[{"title":"b"}]' } })).toEqual({ pages: [{ title: 'b' }] });
  });

  it('--args is the base; other arguments override it', async () => {
    expect(await args(schema, ['--args', '{"name":"base","count":1}', '--count', '2'])).toEqual({ name: 'base', count: 2 });
    expect(await args(schema, ['--count', '2', '--args={"name":"base","count":1}'])).toEqual({ name: 'base', count: 2 });
    expect(await args(schema, ['--args', '@a.json'], { files: { 'a.json': '{"name":"f"}' } })).toEqual({ name: 'f' });
    expect(await args(schema, ['--args', '-'], { stdin: '{"name":"s"}' })).toEqual({ name: 's' });
  });

  it('a lone required string parameter can be given positionally', async () => {
    const search = { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] };
    expect(await args(search, ['rust mcp'])).toEqual({ query: 'rust mcp' });
    expect(await args(search, ['--limit', '3', 'rust'])).toEqual({ query: 'rust', limit: 3 });
    expect(await args(search, ['--', '--odd'])).toEqual({ query: '--odd' });
  });

  it('positional arguments are refused unless exactly one required parameter is a string', async () => {
    const two = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] };
    const err = await failure(two, ['x', '--a', '1', '--b', '2']);
    expect(err.issues).toEqual([{ arg: 'x', message: 'unexpected argument; pass values as --name value' }]);
    const num = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] };
    expect((await failure(num, ['3'])).issues[0]?.message).toMatch(/unexpected argument/);
    const optional = { type: 'object', properties: { q: { type: 'string' } } };
    expect((await failure(optional, ['x'])).issues[0]?.message).toMatch(/unexpected argument/);
  });

  it('a second positional is an error that hints at quoting', async () => {
    const search = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };
    const err = await failure(search, ['rust', 'mcp']);
    expect(err.message).toBe('unexpected argument "mcp"; quote values that contain spaces');
  });
});

describe('parameter names (arguments.md, "参数名")', () => {
  it('accepts snake_case, camelCase and kebab-case spellings', async () => {
    for (const flag of ['--issue-number', '--issue_number', '--issueNumber', '--Issue-Number']) {
      expect(await args(schema, [flag, '4'])).toEqual({ issue_number: 4 });
    }
    for (const flag of ['--pull-number', '--pull_number', '--pullNumber']) {
      expect(await args(schema, [flag, '4'])).toEqual({ pullNumber: 4 });
    }
  });

  it('requires the original names when two parameters normalise to the same name', async () => {
    const clash = { type: 'object', properties: { per_page: { type: 'integer' }, perPage: { type: 'integer' } }, additionalProperties: false };
    expect(await args(clash, ['--per_page', '1', '--perPage', '2'])).toEqual({ per_page: 1, perPage: 2 });
    const err = await failure(clash, ['--per-page', '1']);
    expect(err.issues).toEqual([{ arg: '--per-page', message: 'ambiguous; use one of the original names: per_page, perPage' }]);
  });

  it('--p.<name> addresses a tool parameter that shares a global option name', async () => {
    const withGlobals = { type: 'object', properties: { full: { type: 'boolean' }, timeout: { type: 'integer' }, yes: { type: 'string' } } };
    expect(await args(withGlobals, ['--p.full', '--p.timeout', '30', '--p.yes=maybe'])).toEqual({ full: true, timeout: 30, yes: 'maybe' });
  });

  it('--p.args is a tool parameter named args, not the base object', async () => {
    const s = { type: 'object', properties: { args: { type: 'array', items: { type: 'string' } } } };
    expect(await args(s, ['--p.args', 'a', '--p.args', 'b'])).toEqual({ args: ['a', 'b'] });
  });

  it('--p.<path> works for nested fields', async () => {
    expect(await args(schema, ['--p.filter.state', 'open'])).toEqual({ filter: { state: 'open' } });
  });
});

describe('files and stdin (arguments.md, "从文件或 stdin 读取")', () => {
  it('reads a string argument from @file verbatim', async () => {
    const body = 'line one\n\n{"not": "parsed"}\n';
    expect(await args(schema, ['--query', '@q.txt'], { files: { 'q.txt': body } })).toEqual({ query: body });
  });

  it('parses object and array arguments from @file as JSON', async () => {
    const files = { 'f.json': '{"state":"open"}', 'l.json': '["a","b"]' };
    expect(await args(schema, ['--filter', '@f.json', '--tag', '@l.json'], { files })).toEqual({ filter: { state: 'open' }, tag: ['a', 'b'] });
  });

  it('reads one argument from stdin with -', async () => {
    const io = memoryIO({}, 'from stdin\n');
    expect(await args(schema, ['--name', '-'], { io })).toEqual({ name: 'from stdin\n' });
    expect(io.stdinReads).toBe(1);
  });

  it('allows only one stdin read per call', async () => {
    const io = memoryIO({}, '{"state":"open"}');
    const err = await failure(schema, ['--filter', '-', '--name', '-'], { io });
    expect(err.issues).toEqual([{ arg: '--name', message: 'cannot read stdin: another argument already reads it (only one per call)' }]);
    expect(io.stdinReads).toBe(1);
    const both = await failure(schema, ['--args', '-', '--name', '-'], { io: memoryIO({}, '{}') });
    expect(both.issues[0]?.arg).toBe('--name');
  });

  it('writes @@ for a literal leading @', async () => {
    const io = memoryIO();
    expect(await args(schema, ['--name', '@@octocat'], { io })).toEqual({ name: '@octocat' });
    expect(io.fileReads).toEqual([]);
    expect(await args(schema, ['--tag', '@@a', '--tag', '@@b'], { io })).toEqual({ tag: ['@a', '@b'] });
  });

  it('reports an unreadable file', async () => {
    const err = await failure(schema, ['--query', '@bug.md']);
    expect(err.message).toBe('--query cannot read @bug.md: no such file');
    expect(err.details).toEqual([{ arg: '--query', path: '/query', rule: 'file' }]);
  });

  it('supports @file after =, for positional values and for dot paths', async () => {
    const files = { 'q.txt': 'x', 's.txt': 'open' };
    expect(await args(schema, ['--query=@q.txt', '--filter.state', '@s.txt'], { files })).toEqual({ query: 'x', filter: { state: 'open' } });
    const search = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };
    expect(await args(search, ['@q.txt'], { files })).toEqual({ query: 'x' });
  });
});

describe('merge order (arguments.md, "JSON 输入")', () => {
  it('later paths override earlier ones; objects merge deeply', async () => {
    expect(await args(schema, ['--filter', '{"state":"open","label":"bug"}', '--filter.state', 'closed'])).toEqual({
      filter: { state: 'closed', label: 'bug' },
    });
  });

  it('merges --args, JSON objects and dot paths in command-line order', async () => {
    expect(
      await args(schema, ['--filter.state', 'closed', '--filter', '{"state":"open","inner":{"deep":"a"}}', '--filter.inner.deep', 'b', '--args', '{"filter":{"label":"base"},"name":"n"}']),
    ).toEqual({ name: 'n', filter: { label: 'base', state: 'open', inner: { deep: 'b' } } });
  });

  it('replaces non-object values instead of merging them', async () => {
    expect(await args(schema, ['--tag', 'a', '--args', '{"tag":["z"]}'])).toEqual({ tag: ['a'] });
    expect(await args(schema, ['--filter', '{"state":"open"}', '--filter', '{"label":"x"}'])).toEqual({ filter: { state: 'open', label: 'x' } });
  });
});

describe('--no-validate keeps parsing and conversion', () => {
  it('still converts types and reads files, and reports validated: false', async () => {
    const r = await parse(schema, ['--count', '3', '--name', '@n.txt'], { validate: false, files: { 'n.txt': 'x' } });
    expect(r).toEqual({ args: { count: 3, name: 'x' }, warnings: [], validated: false });
  });

  it('accepts arguments the schema forbids, but not unreadable files', async () => {
    const strict = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
    expect((await parse(strict, ['--b', 'x'], { validate: false })).args).toEqual({ b: 'x' });
    await expect(parse(strict, ['--a', '@missing'], { validate: false })).rejects.toThrow('cannot read @missing');
  });
});
