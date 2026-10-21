// Schema snapshot comparison (arguments.md, "schema 快照校验"): what compatible lets through, what
// it refuses, and what strict adds.
import { describe, expect, it } from 'vitest';
import type { JsonSchema, McpTool } from '../../../src/catalog/types';
import { compareSnapshot, readSnapshot, toolDetail, type SchemaChange, type SchemaMode } from '../../../src/cli/args/snapshot';

const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties, required });

function compare(before: { input?: JsonSchema; output?: JsonSchema }, now: { input?: JsonSchema; output?: JsonSchema }, mode: SchemaMode = 'compatible'): SchemaChange[] {
  const tool: McpTool = { name: 'thing_do', ...(now.input ? { inputSchema: now.input } : {}), ...(now.output ? { outputSchema: now.output } : {}) };
  return compareSnapshot({ ...(before.input ? { inputSchema: before.input } : {}), ...(before.output ? { outputSchema: before.output } : {}) }, tool, mode);
}

/** `side path: message` of the breaking changes only. */
const breaking = (changes: SchemaChange[]): string[] => changes.filter((c) => c.breaking).map((c) => `${c.side} ${c.path}: ${c.message}`);
const all = (changes: SchemaChange[]): string[] => changes.map((c) => `${c.breaking ? '!' : '+'} ${c.side} ${c.path}: ${c.message}`);

const BASE = obj({ owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed'] }, per_page: { type: 'integer' } }, ['owner', 'repo']);

describe('compatible: input', () => {
  it('finds nothing when the schemas are the same, whatever the order of keys and the wording of descriptions', () => {
    const reordered = obj({ per_page: { type: 'integer', description: 'new wording', default: 30 }, state: { enum: ['closed', 'open'], type: 'string' }, repo: { type: 'string' }, owner: { type: 'string', title: 'Owner' } }, ['repo', 'owner']);
    expect(compare({ input: BASE }, { input: reordered })).toEqual([]);
  });

  it('lets a new optional parameter through and refuses a new required one', () => {
    const withOptional = obj({ ...BASE.properties, sort: { type: 'string' } }, ['owner', 'repo']);
    expect(all(compare({ input: BASE }, { input: withOptional }))).toEqual(['+ input --sort: new optional parameter']);
    const withRequired = obj({ ...BASE.properties, sort: { type: 'string' } }, ['owner', 'repo', 'sort']);
    expect(all(compare({ input: BASE }, { input: withRequired }))).toEqual(['! input --sort: new required parameter']);
  });

  it('refuses an optional parameter that became required, and lets the reverse through', () => {
    expect(breaking(compare({ input: BASE }, { input: obj(BASE.properties!, ['owner', 'repo', 'state']) }))).toEqual(['input --state: optional parameter became required']);
    expect(all(compare({ input: BASE }, { input: obj(BASE.properties!, ['owner']) }))).toEqual(['+ input --repo: required parameter became optional']);
  });

  it('refuses a removed parameter, required or not', () => {
    const { per_page: _gone, ...rest } = BASE.properties!;
    expect(breaking(compare({ input: BASE }, { input: obj(rest, ['owner', 'repo']) }))).toEqual(['input --per-page: parameter removed']);
    const { repo: _repo, ...rest2 } = BASE.properties!;
    expect(breaking(compare({ input: BASE }, { input: obj(rest2, ['owner']) }))).toEqual(['input --repo: required parameter removed']);
  });

  it('refuses a changed type, lets a widened one through', () => {
    const now = obj({ ...BASE.properties, owner: { type: 'integer' } }, ['owner', 'repo']);
    expect(breaking(compare({ input: BASE }, { input: now }))).toEqual(['input --owner: type changed: string -> integer']);
    // string -> string|null and integer -> number accept everything the snapshot accepted
    const wider = obj({ ...BASE.properties, owner: { type: ['string', 'null'] }, per_page: { type: 'number' } }, ['owner', 'repo']);
    expect(compare({ input: BASE }, { input: wider })).toEqual([]);
    // the other way narrows
    const narrower = obj({ ...BASE.properties, per_page: { type: 'integer' }, owner: { type: 'string' } }, ['owner', 'repo']);
    expect(compare({ input: wider }, { input: narrower }).filter((c) => c.breaking).map((c) => c.path).sort()).toEqual(['--owner', '--per-page']);
  });

  it('follows $ref and anyOf when it compares types', () => {
    const before = { ...obj({ id: { $ref: '#/$defs/id' } }, ['id']), $defs: { id: { type: 'string' } } };
    const sameViaAnyOf = obj({ id: { anyOf: [{ type: 'string' }] } }, ['id']);
    expect(compare({ input: before }, { input: sameViaAnyOf })).toEqual([]);
    const changed = { ...obj({ id: { $ref: '#/$defs/id' } }, ['id']), $defs: { id: { type: 'integer' } } };
    expect(breaking(compare({ input: before }, { input: changed }))).toEqual(['input --id: type changed: string -> integer']);
  });

  it('compares enums: values may be added, not removed, and a free string may not be limited', () => {
    const grown = obj({ ...BASE.properties, state: { type: 'string', enum: ['open', 'closed', 'merged'] } }, ['owner', 'repo']);
    expect(compare({ input: BASE }, { input: grown })).toEqual([]);
    expect(breaking(compare({ input: grown }, { input: BASE }))).toEqual(['input --state: allowed values removed: "merged"']);
    const limited = obj({ ...BASE.properties, owner: { type: 'string', enum: ['acme'] } }, ['owner', 'repo']);
    expect(breaking(compare({ input: BASE }, { input: limited }))).toEqual(['input --owner: now limited to: "acme"']);
  });

  it('looks into nested objects and arrays of objects', () => {
    const before = obj({ filter: obj({ state: { type: 'string' } }, []), pages: { type: 'array', items: obj({ title: { type: 'string' } }, ['title']) } }, ['filter']);
    const now = obj(
      { filter: obj({ state: { type: 'integer' }, label: { type: 'string' } }, ['label']), pages: { type: 'array', items: obj({ title: { type: 'string' }, body: { type: 'string' } }, ['title', 'body']) } },
      ['filter'],
    );
    expect(breaking(compare({ input: before }, { input: now }))).toEqual([
      'input --filter.state: type changed: string -> integer',
      'input --filter.label: new required parameter',
      'input --pages[].body: new required parameter',
    ]);
  });

  it('writes a parameter that collides with a global option the way it is called', () => {
    const before = obj({ yes: { type: 'boolean' } }, []);
    expect(breaking(compare({ input: before }, { input: obj({}, []) }))).toEqual(['input --p.yes: parameter removed']);
  });
});

describe('compatible: output', () => {
  const OUT = obj({ id: { type: 'string' }, name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, ['id']);

  it('lets new fields through, and a first outputSchema', () => {
    const grown = obj({ ...OUT.properties, owner: obj({ login: { type: 'string' } }) }, ['id']);
    expect(all(compare({ output: OUT }, { output: grown }))).toEqual(['+ output owner: new field']);
    expect(all(compare({}, { output: OUT }))).toEqual(['+ output : outputSchema was added']);
  });

  it('refuses a removed required field, lets a removed optional one go', () => {
    const { id: _id, ...noId } = OUT.properties!;
    expect(breaking(compare({ output: OUT }, { output: obj(noId, []) }))).toEqual(['output id: required field removed']);
    const { name: _name, ...noName } = OUT.properties!;
    expect(all(compare({ output: OUT }, { output: obj(noName, ['id']) }))).toEqual(['+ output name: field removed']);
  });

  it('refuses a required field that became optional, and a type that grew', () => {
    expect(breaking(compare({ output: OUT }, { output: obj(OUT.properties!, []) }))).toEqual(['output id: required field became optional']);
    const nullable = obj({ ...OUT.properties, id: { type: ['string', 'null'] } }, ['id']);
    expect(breaking(compare({ output: OUT }, { output: nullable }))).toEqual(['output id: type changed: string -> null|string']);
    // narrowing is fine for a consumer
    expect(compare({ output: nullable }, { output: OUT })).toEqual([]);
    const retyped = obj({ ...OUT.properties, tags: { type: 'array', items: { type: 'integer' } } }, ['id']);
    expect(breaking(compare({ output: OUT }, { output: retyped }))).toEqual(['output tags[]: type changed: string -> integer']);
  });

  it('refuses a vanished outputSchema', () => {
    expect(all(compare({ output: OUT }, {}))).toEqual(['! output : outputSchema was removed']);
  });

  it('refuses values outside the enum the snapshot lists', () => {
    const before = obj({ state: { type: 'string', enum: ['open', 'closed'] } }, ['state']);
    const now = obj({ state: { type: 'string', enum: ['open', 'closed', 'merged'] } }, ['state']);
    expect(breaking(compare({ output: before }, { output: now }))).toEqual(['output state: new values: "merged"']);
    expect(compare({ output: now }, { output: before })).toEqual([]);
  });
});

describe('strict', () => {
  it('finds nothing in equal schemas, whatever the order of keys and of required', () => {
    const reordered = obj({ repo: BASE.properties!.repo!, owner: BASE.properties!.owner!, per_page: BASE.properties!.per_page!, state: BASE.properties!.state! }, ['repo', 'owner']);
    expect(compare({ input: BASE }, { input: reordered }, 'strict')).toEqual([]);
  });

  it('finds what compatible lets through: a new optional parameter, a changed description', () => {
    const grown = obj({ ...BASE.properties, sort: { type: 'string' } }, ['owner', 'repo']);
    expect(all(compare({ input: BASE }, { input: grown }, 'strict'))).toEqual(['! input properties.sort: added: {"type":"string"}']);
    const reworded = obj({ ...BASE.properties, owner: { type: 'string', description: 'who' } }, ['owner', 'repo']);
    expect(all(compare({ input: BASE }, { input: reworded }, 'strict'))).toEqual(['! input properties.owner.description: added: "who"']);
    expect(all(compare({ output: obj({ a: { type: 'string' } }) }, { output: obj({ a: { type: 'string' }, b: { type: 'string' } }) }, 'strict'))).toEqual(['! output properties.b: added: {"type":"string"}']);
  });

  it('reports changed values, removed keys and required entries', () => {
    const now = obj({ owner: { type: 'integer' }, repo: { type: 'string' }, state: BASE.properties!.state! }, ['owner']);
    expect(all(compare({ input: BASE }, { input: now }, 'strict'))).toEqual([
      '! input properties.owner.type: changed: "string" -> "integer"',
      '! input properties.per_page: removed (was {"type":"integer"})',
      '! input required: removed: repo',
    ]);
    expect(all(compare({}, { output: obj({}) }, 'strict'))).toEqual(['! output : outputSchema was added']);
  });

  it('stops at a bounded number of changes', () => {
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`p${i}`, { type: 'string' }]));
    expect(compare({ input: obj({}) }, { input: obj(many) }, 'strict').length).toBeLessThanOrEqual(41);
  });
});

describe('readSnapshot and toolDetail', () => {
  it('reads a tool detail and a raw MCP tool', () => {
    const detail = toolDetail({ name: 'thing_do', description: 'Do', inputSchema: BASE }, 'acme thing:do', { readOnly: true, destructive: false });
    expect(detail).toEqual({ tool: 'acme thing:do', rawName: 'thing_do', description: 'Do', readOnly: true, inputSchema: BASE });
    expect(readSnapshot(detail)).toEqual({ inputSchema: BASE, rawName: 'thing_do' });
    expect(readSnapshot({ name: 'x', inputSchema: BASE, outputSchema: obj({}) })).toEqual({ inputSchema: BASE, outputSchema: obj({}), rawName: 'x' });
  });

  it('says why a file is not a snapshot', () => {
    expect(readSnapshot([])).toMatch(/expected a JSON object/);
    expect(readSnapshot({ tools: [] })).toMatch(/neither inputSchema nor outputSchema/);
    expect(readSnapshot({ inputSchema: 3 })).toMatch(/inputSchema is not an object/);
  });

  it('gives a tool without a schema an empty object schema', () => {
    expect(toolDetail({ name: 'x' }, 'p x', { readOnly: false, destructive: true })).toEqual({ tool: 'p x', rawName: 'x', destructive: true, inputSchema: { type: 'object' } });
  });
});
