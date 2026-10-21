// The call example of `-h` (arguments.md, "帮助"): shaped by the schema, short, pasteable, and
// accepted by the same parser and validator a real call goes through.
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { McpTool } from '../../../src/catalog/types';
import { formatToolHelp, parseToolArgs } from '../../../src/cli/args';
import { formatCallExample } from '../../../src/cli/args/example';
import { fixtureNames, loadTools } from '../../helpers/fixtures';
import { CTX, makeTool, memoryIO, type SchemaLike } from './helpers';

const example = (schema: SchemaLike, ctx = CTX): string | undefined => formatCallExample(makeTool(schema), ctx);
const PREFIX = 'example: via acme thing:do';

const PAGE = {
  type: 'object',
  properties: { title: { type: 'string' }, children: { type: 'array', items: { $ref: '#/$defs/Page' } } },
  required: ['title', 'children'],
};

const COMPLEX = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    filter: {
      type: 'object',
      properties: {
        state: { enum: ['open', 'closed'] },
        labels: { type: 'array', items: { type: 'string' } },
        range: { type: 'object', properties: { from: { type: 'string', format: 'date' }, to: { type: 'string' } }, required: ['from'] },
      },
      required: ['state', 'range'],
    },
    pages: { type: 'array', items: { $ref: '#/$defs/Page' } },
    point: { type: 'array', prefixItems: [{ type: 'number' }, { type: 'number' }] },
    legacy_tuple: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }] },
    due: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
    count: { type: ['integer', 'null'], minimum: 5 },
    draft: { type: 'boolean', default: false },
  },
  required: ['title', 'filter', 'pages', 'point', 'due'],
  $defs: { Page: PAGE },
};

// The expected lines are written the way a POSIX shell needs them; Windows quoting is covered in test/render/shell.test.ts.
describe.skipIf(process.platform === 'win32')('formatCallExample', () => {
  it('covers nested objects, arrays of objects, local $ref, tuples and nullable values', () => {
    expect(example(COMPLEX)).toMatchInlineSnapshot(
      `"example: via acme thing:do --title text --filter.state open --filter.range.from 2026-01-15 --pages '[{"title":"text","children":[]}]' --point '[1,1]' --due 2026-01-15T09:00:00Z"`,
    );
  });

  it('ends the -h text, just before the alias line', async () => {
    const help = formatToolHelp(makeTool(COMPLEX, { description: 'Do the thing' }), CTX);
    await expect(`${help}\n`).toMatchFileSnapshot('../__snapshots__/help-example.txt');
    const lines = help.split('\n');
    expect(lines.at(-2)).toMatch(/^example: via acme thing:do /);
    expect(lines.at(-1)).toBe('alias: thing_do');
  });

  it('writes tuples (prefixItems and the old array form of items) as JSON, a boolean as a flag, a nullable by its other type', () => {
    expect(example({ ...COMPLEX, required: ['legacy_tuple', 'count', 'draft'] })).toBe(`${PREFIX} --legacy-tuple '["text",1]' --count 5 --draft`);
  });

  it('fills the required parameters first, then optional ones up to three parameters in all', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' }, d: { type: 'string' }, e: { type: 'string' } },
      required: ['c'],
    };
    expect(example(schema)).toBe(`${PREFIX} --c text --a text --b text`);
    expect(example({ ...schema, required: ['a', 'b', 'c', 'd'] })).toBe(`${PREFIX} --a text --b text --c text --d text`);
  });

  it('uses the repeated flag for a list of scalars and JSON for anything else', () => {
    const schema = {
      type: 'object',
      properties: { tag: { type: 'array', items: { type: 'string' } }, ids: { type: 'array', items: { type: 'integer' }, minimum: 1 }, rows: { type: 'array', items: { type: 'object', properties: { k: { type: 'string' } }, required: ['k'] } } },
      required: ['tag', 'ids', 'rows'],
    };
    expect(example(schema)).toBe(`${PREFIX} --tag text --ids 1 --rows '[{"k":"text"}]'`);
  });

  it('takes enum and const as they are, then examples, then defaults, and generates the rest from type, bounds and format', () => {
    const schema = {
      type: 'object',
      properties: {
        mode: { const: 'fast' },
        level: { type: 'integer', minimum: 3, maximum: 9 },
        top: { type: 'integer', maximum: 0 },
        ratio: { type: 'number', exclusiveMinimum: 0 },
        at: { type: 'string', format: 'email' },
        name: { type: 'string', examples: ['acme'], default: 'other' },
        limit: { type: 'integer', default: 30 },
        free: { type: 'object' },
      },
      required: ['mode', 'level', 'top', 'ratio', 'at', 'name', 'limit', 'free'],
    };
    expect(example(schema)).toBe(`${PREFIX} --mode fast --level 3 --top 0 --ratio 1 --at user@example.com --name acme --limit 30 --free '{}'`);
  });

  it('leaves out an optional parameter whose example is an empty container, and one that would make the line long', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' }, filters: { type: 'object' }, list: { type: 'array' }, long: { enum: ['x'.repeat(250)] } }, required: ['q'] };
    expect(example(schema)).toBe(`${PREFIX} --q text`);
  });

  it('is absent when the tool takes no arguments or the example would be long', () => {
    expect(example({ type: 'object', properties: {} })).toBeUndefined();
    expect(example(undefined)).toBeUndefined();
    const big = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`parameter_number_${i}`, { type: 'string' }]));
    expect(example({ type: 'object', properties: big, required: Object.keys(big) })).toBeUndefined();
  });

  it('writes the flag of a name that collides with a global option, and quotes names that need it', () => {
    expect(example({ type: 'object', properties: { yes: { type: 'boolean' }, full: { type: 'string' } }, required: ['yes', 'full'] })).toBe(`${PREFIX} --p.yes --p.full text`);
    const clash = { type: 'object', properties: { '$(a)': { type: 'string' }, '$(A)': { type: 'string' } }, required: ['$(a)'] };
    // the collision keeps the original names, which are written as one quoted word each
    expect(example(clash)).toBe(`${PREFIX} '--$(a)' text '--$(A)' text`);
  });

  it('writes a value that starts with a dash as --name=value, and a negative number the same way', () => {
    const schema = { type: 'object', properties: { sort: { enum: ['-created', 'created'] }, delta: { type: 'integer', minimum: -5 } }, required: ['sort', 'delta'] };
    expect(example(schema)).toBe(`${PREFIX} --sort=-created --delta=-5`);
  });

  it('uses the words of the reference when a part of it contains a space (prompts)', () => {
    const line = formatCallExample(makeTool({ type: 'object', properties: { code: { type: 'string' } }, required: ['code'] }), { ...CTX, ref: 'prompts acme review code', refWords: ['prompts', 'acme', 'review code'] });
    expect(line).toBe(`example: via prompts acme 'review code' --code text`);
  });

  it('does not loop on a schema that refers to itself', () => {
    const schema = { $ref: '#/$defs/Node', $defs: { Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' } }, required: ['next'] } } };
    const line = example({ type: 'object', properties: { head: { $ref: '#/$defs/Node' } }, required: ['head'], $defs: schema.$defs });
    expect(line).toBeDefined();
    expect(line!.length).toBeLessThan(200);
  });
});

describe.skipIf(process.platform === 'win32')('hostile schemas', () => {
  const schemaWith = (value: string): SchemaLike => ({
    type: 'object',
    properties: { mode: { enum: [value, 'safe'] }, other: { type: 'string', default: value, examples: [value] } },
    required: ['mode', 'other'],
  });

  it('quote a value from the schema that a shell would act on, so that the shell reads it back as it is', () => {
    for (const value of ['$(touch PWNED)', '`touch PWNED`', '$HOME; id']) {
      expect(example(schemaWith(value)), value).toBe(`${PREFIX} --mode '${value}' --other '${value}'`);
    }
  });

  it('use another value where the schema value has no safe spelling, or would be read as a file or stdin', () => {
    for (const value of ["x'; touch PWNED; '", 'a\nb', '\u202eevil', 'a\u001b[2Jb']) {
      expect(example(schemaWith(value)), JSON.stringify(value)).toBe(`${PREFIX} --mode safe --other text`);
    }
    expect(example(schemaWith('@/etc/passwd'))).toBe(`${PREFIX} --mode safe --other text`);
    expect(example(schemaWith('-'))).toBe(`${PREFIX} --mode safe --other text`);
  });

  it('leave out a parameter whose only allowed values cannot be written, and the whole example when it is required', () => {
    expect(example({ type: 'object', properties: { mode: { enum: ['$(touch PWNED)\nx'] }, q: { type: 'string' } }, required: ['q'] })).toBe(`${PREFIX} --q text`);
    expect(example({ type: 'object', properties: { mode: { enum: ['$(touch PWNED)\nx'] } }, required: ['mode'] })).toBeUndefined();
  });

  it('refuse a property name with no safe spelling inside a JSON value', () => {
    const line = example({ type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { "a'; touch PWNED; $(x)": { type: 'string' } }, required: ["a'; touch PWNED; $(x)"] } } }, required: ['rows'] });
    expect(line).toBeUndefined();
  });
});

/** Every word of the example read by a real shell, then through the parser and validator of a call. */
describe.skipIf(process.platform === 'win32')('the example is a call that goes through', () => {
  async function accepted(tool: McpTool, ctx = CTX): Promise<void> {
    const line = formatCallExample(tool, ctx);
    if (line === undefined) return;
    expect(line.length, line).toBeLessThanOrEqual(400);
    const rest = line.slice(`example: via ${ctx.ref}`.length);
    const words = execFileSync('sh', ['-c', `printf '%s\\0' ${rest}`], { encoding: 'utf8' }).split('\0').slice(0, -1);
    const io = memoryIO();
    await parseToolArgs(words, tool, ctx, { io, validate: true });
    expect(io.fileReads).toEqual([]);
  }

  it('for a schema with every kind of value', async () => {
    await accepted(makeTool(COMPLEX));
    await accepted(makeTool({ ...COMPLEX, required: ['legacy_tuple', 'count', 'draft', 'filter'] }));
  });

  for (const dir of ['tools', 'other']) {
    for (const name of fixtureNames(dir)) {
      it(`for every tool of the ${name} fixture`, async () => {
        for (const tool of loadTools(dir, name)) {
          const ctx = { provider: name, ref: `${name} ${tool.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`, rawName: tool.name, readOnly: false, destructive: false };
          await accepted(tool, ctx);
        }
      });
    }
  }
});
