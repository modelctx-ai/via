import { describe, expect, it } from 'vitest';
import { validateOutput } from '../../../src/cli/args';
import { makeTool } from './helpers';

const outputSchema = {
  type: 'object',
  properties: {
    total: { type: 'integer' },
    items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id', 'name'] } },
  },
  required: ['total'],
};

describe('validateOutput (arguments.md, "输出校验")', () => {
  const tool = makeTool({ type: 'object' }, { name: 'issue_list', outputSchema });

  it('returns nothing for a conforming result or a tool without outputSchema', async () => {
    expect(await validateOutput(tool, { total: 1, items: [{ id: 'a', name: 'b' }] })).toEqual([]);
    expect(await validateOutput(makeTool({ type: 'object' }), { anything: true })).toEqual([]);
    expect(await validateOutput(tool, undefined)).toEqual([]);
  });

  it('warns about every mismatch with a path, without echoing values', async () => {
    const secret = 'sk-fake-output-value';
    expect(await validateOutput(tool, { total: secret, items: [{ id: 3, name: 'n' }, {}] })).toEqual([
      'issue_list result does not match its outputSchema: total must be integer',
      'issue_list result does not match its outputSchema: items[0].id must be string',
      'issue_list result does not match its outputSchema: items[1] is missing "id"',
      'issue_list result: 1 more outputSchema mismatches',
    ]);
    expect((await validateOutput(tool, { total: secret })).join('\n')).not.toContain(secret);
  });

  it('never throws: uncompilable schemas and odd input give no warnings', async () => {
    const broken = makeTool({ type: 'object' }, { outputSchema: { type: 'object', properties: { n: { type: 'integer', minimum: 'x' } } } });
    expect(await validateOutput(broken, { n: 1 })).toEqual([]);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(validateOutput(tool, circular)).resolves.toBeInstanceOf(Array);
  });

  it('ignores format and external $ref in output schemas', async () => {
    const t = makeTool({ type: 'object' }, { outputSchema: { type: 'object', properties: { at: { type: 'string', format: 'date-time' }, x: { $ref: 'https://example.com/x.json' } } } });
    expect(await validateOutput(t, { at: 'yesterday', x: 1 })).toEqual([]);
  });
});
