import { describe, expect, it } from 'vitest';
import { args, failure, parse } from './helpers';

// One test group per row/rule of the "JSON 输入" section of arguments.md.
describe('JSON input', () => {
  it('string parameters are never parsed, even when the text is JSON', async () => {
    const s = { type: 'object', properties: { query: { type: 'string' } } };
    expect(await args(s, ['--query', '{"bool":{"must":[]}}'])).toEqual({ query: '{"bool":{"must":[]}}' });
    expect(await args(s, ['--query', '[1,2]'])).toEqual({ query: '[1,2]' });
    expect(await args(s, ['--query', '@query.json'], { files: { 'query.json': '{"bool":{}}\n' } })).toEqual({ query: '{"bool":{}}\n' });
    expect(await args(s, ['--args', '{"query":"{\\"a\\":1}"}'])).toEqual({ query: '{"a":1}' });
  });

  it('object and array parameters are parsed as JSON', async () => {
    const s = {
      type: 'object',
      properties: { filter: { type: 'object', properties: { state: { type: 'string' } } }, labels: { type: 'array', items: { type: 'string' } } },
    };
    expect(await args(s, ['--filter', '{"state":"open"}', '--labels', '["bug","p1"]'])).toEqual({ filter: { state: 'open' }, labels: ['bug', 'p1'] });
  });

  it('loose schemas: JSON when the value is valid JSON, otherwise a string', async () => {
    const s = { type: 'object', properties: { payload: {}, count: {}, name: {}, free: { type: 'object' } }, additionalProperties: false };
    expect(await args(s, ['--payload', '{"a":[1,2]}'])).toEqual({ payload: { a: [1, 2] } });
    expect(await args(s, ['--count', '3'])).toEqual({ count: 3 });
    expect(await args(s, ['--name', 'acme'])).toEqual({ name: 'acme' });
    expect(await args(s, ['--name', 'true', '--payload', '[1'])).toEqual({ name: true, payload: '[1' });
    // an object without declared fields that allows anything is loose too
    expect(await args(s, ['--free', '{"x":1}'])).toEqual({ free: { x: 1 } });
    // a non-JSON value stays a string; validation (not conversion) then says it is not an object
    expect((await parse(s, ['--free', 'plain'], { validate: false })).args).toEqual({ free: 'plain' });
    expect((await failure(s, ['--free', 'plain'])).message).toBe('--free must be an object (got "plain")');
  });

  it('a parameter without type but with an enum converts by the enum values', async () => {
    const s = { type: 'object', properties: { level: { enum: [1, 2, 3] }, mode: { enum: ['a', 'b'] } } };
    expect(await args(s, ['--level', '2', '--mode', 'a'])).toEqual({ level: 2, mode: 'a' });
  });

  it('type: ["string","object"]: JSON only when the value starts with { and parses', async () => {
    const s = { type: 'object', properties: { q: { type: ['string', 'object'] } } };
    expect(await args(s, ['--q', '{"a":1}'])).toEqual({ q: { a: 1 } });
    expect(await args(s, ['--q', '{not json'])).toEqual({ q: '{not json' });
    expect(await args(s, ['--q', '[1,2]'])).toEqual({ q: '[1,2]' });
    expect(await args(s, ['--q', 'plain'])).toEqual({ q: 'plain' });
    expect(await args(s, ['--args', '{"q":"{\\"a\\":1}"}'])).toEqual({ q: '{"a":1}' });
  });

  it('type: ["string","array"]: starting with [ and parsing makes an array', async () => {
    const s = { type: 'object', properties: { q: { type: ['string', 'array'], items: { type: 'string' } } } };
    expect(await args(s, ['--q', '["a"]'])).toEqual({ q: ['a'] });
    expect(await args(s, ['--q', '[a'])).toEqual({ q: '[a' });
  });

  it('roots that allow extra fields accept unknown --key value, converted like loose values', async () => {
    const noProps = { type: 'object' };
    expect(await args(noProps, ['--limit', '5', '--name', 'x', '--meta', '{"a":1}', '--verbose'])).toEqual({
      limit: 5,
      name: 'x',
      meta: { a: 1 },
      verbose: true,
    });
    const declared = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    expect(await args(declared, ['--a', 'x', '--extra', '2', '--other.deep', 'y'])).toEqual({ a: 'x', extra: 2, other: { deep: 'y' } });
    const open = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'integer' } };
    expect(await args(open, ['--n', '4'])).toEqual({ n: 4 });
  });

  it('rejects unknown arguments when additionalProperties is false', async () => {
    const closed = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
    const err = await failure(closed, ['--zzz', 'x']);
    expect(err.issues).toEqual([{ arg: '--zzz', message: 'unknown argument' }]);
  });

  it('JSON that does not parse is a usage error naming the argument and the position', async () => {
    const s = { type: 'object', properties: { filter: { type: 'object', properties: { state: { type: 'string' } } } } };
    const err = await failure(s, ['--filter', '{"state":"open", }']);
    expect(err.exitCode).toBe(2);
    expect(err.issues).toEqual([{ arg: '--filter', message: 'invalid JSON at 1:18: unexpected "}"; consider @file' }]);
    expect(err.message).toBe('--filter invalid JSON at 1:18: unexpected "}"; consider @file');
    expect(err.details).toEqual([{ arg: '--filter', path: '/filter', rule: 'json' }]);
  });

  it('locates errors on later lines, in files and at the end of input', async () => {
    const s = { type: 'object', properties: { pages: { type: 'array', items: { type: 'object' } } } };
    const file = await failure(s, ['--pages', '@p.json'], { files: { 'p.json': '[\n  {"a": 1},\n  {"b": }\n]' } });
    expect(file.issues[0]).toEqual({ arg: '--pages', message: 'invalid JSON at 3:9 in @p.json: unexpected "}"' });
    const eof = await failure(s, ['--pages', '[{"a":1}']);
    expect(eof.issues[0]?.message).toBe('invalid JSON at 1:9: unexpected end of input; consider @file');
    const stdin = await failure(s, ['--pages', '-'], { stdin: '[1,]' });
    expect(stdin.issues[0]?.message).toBe('invalid JSON at 1:4 in stdin: unexpected "]"');
  });

  it('--args must be a JSON object', async () => {
    const s = { type: 'object', properties: { a: { type: 'string' } } };
    expect((await failure(s, ['--args', '[1]'])).issues).toEqual([{ arg: '--args', message: 'must be a JSON object' }]);
    expect((await failure(s, ['--args', '{"a":'])).issues[0]?.message).toMatch(/^invalid JSON at 1:6/);
    expect((await failure(s, ['--args'])).issues).toEqual([{ arg: '--args', message: 'requires a value' }]);
  });

  it('a value that fails to parse does not also report the parameter as missing', async () => {
    const s = { type: 'object', properties: { filter: { type: 'object' }, other: { type: 'string' } }, required: ['filter', 'other'] };
    const err = await failure(s, ['--filter', '{oops', '--other', 'x']);
    expect(err.issues.map((i) => i.arg)).toEqual(['--filter']);
  });

  it('keeps __proto__ out of the argument object', async () => {
    const s = { type: 'object', properties: { a: { type: 'string' } } };
    const out = await args(s, ['--__proto__.polluted', 'yes']).catch(() => undefined);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(out === undefined || !('polluted' in (Object.getPrototypeOf(out) ?? {}))).toBe(true);
    const closed = { type: 'object', additionalProperties: false };
    expect((await failure(closed, ['--__proto__', 'x'])).issues[0]?.message).toBe('unknown argument');
  });
});
