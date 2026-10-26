import { describe, expect, it } from 'vitest';
import { extractParams, formatSignature, TYPED_SIGNATURE_MAX_WIDTH } from '../../src/catalog';
import { formatUsage } from '../../src/cli/args';
import type { JsonSchema } from '../../src/catalog';
import { fixtureNames, loadTools } from '../helpers/fixtures';

// The types and allowed values in a signature (discovery.md, "浏览视图") are read from the schema
// without the argument parser, and must say what the `usage:` line says.

const sig = (schema: JsonSchema, typed = true): string => formatSignature(extractParams(schema), 6, typed);

describe('typed signatures', () => {
  it('writes enums as name=a|b, numbers as name:num and optional flags as [name?]', () => {
    const schema = {
      type: 'object',
      properties: { owner: { type: 'string' }, issue_number: { type: 'integer' }, method: { enum: ['get', 'get_comments'] }, draft: { type: 'boolean' } },
      required: ['owner', 'issue_number', 'method'],
    };
    expect(sig(schema)).toBe('owner, issue-number:num, method=get|get_comments, [draft?]');
    expect(sig(schema, false)).toBe('owner, issue-number, method, [draft]');
  });

  it('writes objects as :json, a list of scalars as :str[], and a union of types as :a|b', () => {
    const schema = { properties: { labels: { type: 'array', items: { type: 'string' } }, filter: { type: 'object', properties: { a: {} } }, id: { type: ['string', 'integer'] } } };
    expect(sig(schema)).toBe('[labels:str[]], [filter:json], [id:str|num]');
  });

  it('keeps every required parameter and cuts optional ones at six in all, typed or not', () => {
    const properties = Object.fromEntries('abcdefgh'.split('').map((n) => [n, { type: 'number' }]));
    expect(sig({ properties, required: ['a', 'b'] })).toBe('a:num, b:num, [c:num], [d:num], [e:num], [f:num], …');
    expect(sig({ properties, required: ['a', 'b'] }, false)).toBe('a, b, [c], [d], [e], [f], …');
    expect(sig({ properties: Object.fromEntries('abcdefgh'.split('').map((n) => [n, { type: 'number' }])), required: [...'abcdefgh'] })).toBe('a:num, b:num, c:num, d:num, e:num, f:num, g:num, h:num');
  });

  it('writes a required flag as name:bool, since [name?] means optional', () => {
    expect(sig({ properties: { force: { type: 'boolean' }, dry: { type: 'boolean' } }, required: ['force'] })).toBe('force:bool, [dry?]');
  });

  it('falls back to the plain signature when the typed one is wider than 60 columns', () => {
    const properties = {
      state: { enum: ['open', 'closed', 'all'] },
      sort: { enum: ['created', 'updated', 'comments'] },
      direction: { enum: ['asc', 'desc'] },
      since: { type: 'string' },
    };
    const typed = 'state=open|closed|all, sort=created|updated|comments, direction=asc|desc';
    expect(typed.length).toBeGreaterThan(TYPED_SIGNATURE_MAX_WIDTH);
    expect(sig({ properties, required: ['state', 'sort', 'direction'] })).toBe('state, sort, direction, [since]');
    expect(sig({ properties: { state: properties.state }, required: ['state'] })).toBe('state=open|closed|all');
  });

  it('follows local $ref, anyOf and const the way the usage line does, and says nothing about a string or an unstated type', () => {
    const schema = {
      $defs: { Method: { enum: ['get', 'list'] }, Count: { type: 'integer' } },
      properties: {
        method: { $ref: '#/$defs/Method' },
        count: { $ref: '#/$defs/Count' },
        kind: { anyOf: [{ const: 'a' }, { const: 'b' }] },
        maybe: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        anything: {},
        text: { type: 'string' },
      },
      required: ['method', 'count', 'kind', 'maybe', 'anything', 'text'],
    };
    expect(sig(schema)).toBe('method=get|list, count:num, kind=a|b, maybe, anything, text');
    expect(sig({ properties: { mode: { type: 'string', enum: ['x'] } } })).toBe('[mode=x]');
  });

  it('shows control characters of an enum value as escapes', () => {
    expect(sig({ properties: { m: { enum: ['a\nb', 'c'] } }, required: ['m'] })).toBe('m=a\\nb|c');
  });

  it('gives an enum that does not fit on a usage line a type instead', () => {
    const values = Array.from({ length: 30 }, (_, i) => `value-${i}`);
    expect(sig({ properties: { v: { enum: values } }, required: ['v'] })).toBe('v');
  });
});

/** The placeholder the `usage:` line shows after `--flag`: `<num>`, `get|list`, or none for a flag. */
function usagePlaceholder(usage: string, arg: string): string | undefined | null {
  const text = usage.replace(/\n\s+/g, ' ');
  const escaped = arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`--(?:p\\.)?${escaped}(?: (<[^>]+>|[^\\s\\]\\[\\-][^\\s\\]]*))?(?=[\\] ]|$)`).exec(text);
  return m === null ? null : m[1];
}

describe('typed signatures agree with the usage line', () => {
  const providers = fixtureNames('tools');
  it.each(providers)('%s', (name) => {
    let checked = 0;
    for (const tool of loadTools('tools', name)) {
      const usage = formatUsage(tool, { provider: name, ref: `${name} x:y`, rawName: tool.name, readOnly: false, destructive: false });
      for (const p of extractParams(tool.inputSchema)) {
        const shown = usagePlaceholder(usage, p.arg);
        if (shown === null) continue; // a name the usage line writes in another form (collisions, quoting)
        checked += 1;
        const where = `${name}/${tool.name} --${p.arg}`;
        if (p.values !== undefined) expect(shown, where).toBe(p.values);
        else if (p.type === 'bool') expect(shown, where).toBeUndefined();
        else if (p.type !== undefined) expect(shown, where).toBe(`<${p.type}>`);
        else expect(['<str>', '<value>'], where).toContain(shown);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
