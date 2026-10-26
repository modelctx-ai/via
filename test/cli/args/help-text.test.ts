// `-h` text (arguments.md, "参数名", "调用示例", "帮助"): a parameter whose name has no letter or digit,
// examples without parameters that say nothing, `--full`, the keys of an array of objects, and the
// type of a list of scalars. The tools are made up; they have the shapes of real ones.
import { describe, expect, it } from 'vitest';
import type { McpTool } from '../../../src/catalog/types';
import { extractParams, formatSignature } from '../../../src/catalog';
import { formatToolHelp, formatUsage } from '../../../src/cli/args';
import { formatCallExample } from '../../../src/cli/args/example';
import { CTX, failure, args, makeTool } from './helpers';

const IGNORED = { description: 'Ignored.' };

/** A schema in which two parameters take no value worth showing. */
const LIST = {
  type: 'object',
  properties: { _: IGNORED, reason: IGNORED },
  additionalProperties: false,
};

const ITEM = {
  type: 'object',
  properties: {
    todoId: { type: 'string', description: 'The card to build' },
    withPlan: { type: 'boolean', description: 'Write a plan before the first step', default: false },
    machineId: { type: 'string' },
    mode: { type: 'string', enum: ['fast', 'careful'], description: 'How much checking the build does' },
  },
  required: ['todoId'],
};

const RUN = {
  type: 'object',
  properties: {
    items: { type: 'array', description: 'What to build.', items: ITEM },
    todoIds: { type: 'array', items: { type: 'string' }, description: 'Cards to touch' },
    _: IGNORED,
  },
  required: ['items'],
};

const LONG_DESCRIPTION = [
  'Run builds for cards.',
  '',
  'Use this only on the explicit request of the user.',
  '',
  '',
  'The spec must follow the layout above:',
  '  - one title line',
  '  - one body',
].join('\n');

const board = (name: string, inputSchema: object, extra: Partial<McpTool> = {}) => makeTool(inputSchema, { name, ...extra });
const ctxOf = (ref: string, rawName: string) => ({ ...CTX, ref, rawName });

describe('a parameter whose name has no kebab-case spelling (arguments.md, "参数名")', () => {
  const ctx = ctxOf('board project:list', 'project_list');
  const tool = board('project_list', LIST);

  it('keeps the original name in the signature, usage and help', () => {
    const params = extractParams(LIST);
    expect(params.map((p) => p.arg)).toEqual(['_', 'reason']);
    expect(formatSignature(params)).toBe('[_], [reason]');
    expect(formatUsage(tool, ctx)).toBe('usage: via board project:list [--_ <value>] [--reason <value>]');
    const help = formatToolHelp(tool, ctx);
    expect(help).not.toMatch(/\n {2}-- /);
    expect(help).toContain('\n  --_        Ignored.\n  --reason   Ignored.\n');
  });

  it('is accepted by the parser as --_ and --_=, and named as --_ in errors', async () => {
    expect(await args(LIST, ['--_', 'x'])).toEqual({ _: 'x' });
    expect(await args(LIST, ['--_=x', '--reason', 'y'])).toEqual({ _: 'x', reason: 'y' });
    const err = await failure({ ...LIST, properties: { ...LIST.properties, _: { type: 'integer' } } }, ['--_', 'x']);
    expect(err.message).toBe('--_ must be an integer (got "x")');
    expect(err.usage).toContain('[--_ <num>]');
    expect((await failure(LIST, ['-- x'.split(' ')[1]!, 'x'])).message).toContain('unexpected argument');
  });

  it('applies to any name without a letter or digit, and two such names stay apart', async () => {
    const schema = { type: 'object', properties: { _: { type: 'string' }, __: { type: 'string' }, '-': { type: 'string' } }, additionalProperties: false };
    expect(extractParams(schema).map((p) => p.arg)).toEqual(['_', '__', '-']);
    expect(await args(schema, ['--_', 'a', '--__', 'b', '---', 'c'])).toEqual({ _: 'a', __: 'b', '-': 'c' });
  });

  it('suggests it for a near miss', async () => {
    const err = await failure({ ...LIST, properties: { _: IGNORED } }, ['--__', 'x']);
    expect(err.message).toBe('unknown argument --__; did you mean --_?');
  });
});

describe('the call example skips optional parameters that say nothing (arguments.md, "调用示例")', () => {
  const ctx = ctxOf('board project:list', 'project_list');

  it('writes no example for a tool whose only parameters are untyped and optional', () => {
    expect(formatCallExample(board('project_list', LIST), ctx)).toBeUndefined();
    expect(formatToolHelp(board('project_list', LIST), ctx)).not.toContain('example:');
  });

  it('fills up to three parameters from the ones that have a type, an enum, an example or a default', () => {
    const schema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        _: IGNORED,
        note: { description: 'Anything' },
        kind: { enum: ['a', 'b'] },
        hint: { examples: ['x1'] },
        limit: { default: 5 },
        reason: IGNORED,
        count: { type: 'integer' },
      },
      required: ['title'],
    };
    expect(formatCallExample(board('project_list', schema), ctx)).toBe('example: via board project:list --title text --kind a --hint x1');
  });

  it('keeps an untyped required parameter', () => {
    expect(formatCallExample(board('project_list', { type: 'object', properties: { _: IGNORED, q: IGNORED }, required: ['q'] }), ctx)).toBe('example: via board project:list --q text');
  });
});

describe('-h --full (arguments.md, "帮助")', () => {
  const ctx = ctxOf('board build:run', 'build_run');
  const tool = board('build_run', RUN, { description: LONG_DESCRIPTION });

  it('cuts the description and says how to read all of it', () => {
    const help = formatToolHelp(tool, ctx);
    expect(help).toContain('\nRun builds for cards.\n  --items');
    expect(help).not.toContain('explicit request');
    expect(help.split('\n').slice(-2)).toEqual(['full text: via board build:run -h --full', 'alias: build_run']);
  });

  it('prints the whole description with its paragraphs, and whole parameter descriptions', () => {
    const wide = {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'The spec, a title line first.\nThen the body, as in the layout above.\nNo trailing text. '.repeat(2) },
        mode: { enum: Array.from({ length: 14 }, (_, i) => `mode-number-${i}`) },
      },
      required: ['spec'],
    };
    const help = formatToolHelp(board('build_run', wide, { description: LONG_DESCRIPTION }), ctx, { full: true });
    expect(help).toMatchInlineSnapshot(`
      "usage: via board build:run --spec <str> [--mode <str>]

      Run builds for cards.

      Use this only on the explicit request of the user.

      The spec must follow the layout above:
        - one title line
        - one body

        --spec   The spec, a title line first.
                 Then the body, as in the layout above.
                 No trailing text. The spec, a title line first.
                 Then the body, as in the layout above.
                 No trailing text.
        --mode   one of: mode-number-0, mode-number-1, mode-number-2, mode-number-3, mode-number-4, mode-number-5, mode-number-6, mode-number-7, mode-number-8, mode-number-9, mode-number-10, mode-number-11, mode-number-12, mode-number-13
      accepts extra fields: --<name> <value>
      example: via board build:run --spec text --mode mode-number-0
      alias: build_run"
    `);
    expect(help).not.toContain('full text:');
  });

  it('shows no hint when nothing is cut, with or without --full', () => {
    const small = board('build_run', { type: 'object', properties: { q: { type: 'string', description: 'Query' } }, required: ['q'] }, { description: 'Search.' });
    expect(formatToolHelp(small, ctx)).not.toContain('full text:');
    expect(formatToolHelp(small, ctx, { full: true })).toBe(formatToolHelp(small, ctx));
  });

  it('counts a long parameter description, a long enum list and fields over the limit as cut', () => {
    const cases: Record<string, object> = {
      parameter: { q: { type: 'string', description: 'x'.repeat(100) } },
      values: { q: { enum: Array.from({ length: 30 }, (_, i) => `value-number-${i}`) } },
      lines: { q: { type: 'string', description: 'Query\nsecond line that does not fit on the row anyway, so the row is cut after the first one' } },
      fields: { q: { type: 'object', properties: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`f${i}`, { type: 'string' }])) } },
    };
    for (const [name, properties] of Object.entries(cases)) {
      const help = formatToolHelp(board('build_run', { type: 'object', properties }), ctx);
      expect(help, name).toContain('full text: via board build:run -h --full');
    }
  });

  it('writes the hint with the words of a prompt reference', () => {
    const prompt = { ...ctx, ref: 'prompts board review', refWords: ['prompts', 'board', 'review'], rawName: 'review' };
    expect(formatToolHelp(board('review', { type: 'object', properties: { q: { type: 'string', description: 'x'.repeat(100) } } }), prompt)).toContain(
      '\nfull text: via prompts board review -h --full\n',
    );
  });
});

describe('the keys of an array of objects (arguments.md, "帮助")', () => {
  const ctx = ctxOf('board build:run', 'build_run');

  it('lists them under the parameter, with the JSON spelling, requirement and description', () => {
    expect(formatToolHelp(board('build_run', RUN, { description: 'Run builds' }), ctx)).toMatchInlineSnapshot(`
      "usage: via board build:run --items <json> [--todo-ids <str[]>] [--_ <value>]

      Run builds
        --items       What to build. · JSON array of objects with keys:
          todoId      str · required · The card to build
          withPlan    bool · Write a plan before the first step · default: false
          machineId   str
          mode        fast|careful · How much checking the build does
        --todo-ids    Cards to touch · repeat the flag or pass a JSON array
        --_           Ignored.
      accepts extra fields: --<name> <value>
      example: via board build:run --items '[{"todoId":"text"}]' --todo-ids text
      alias: build_run"
    `);
  });

  it('lists at most 12 keys and counts the rest; --full lists all', () => {
    const many = { type: 'array', items: { type: 'object', properties: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`field${i}`, { type: 'integer' }])), required: ['field0'] } };
    const tool = board('build_run', { type: 'object', properties: { rows: many }, required: ['rows'] });
    const help = formatToolHelp(tool, ctx);
    expect(help).toContain('\n    field11   num\n    … 3 more\n');
    expect(help).not.toContain('field12');
    const full = formatToolHelp(tool, ctx, { full: true });
    expect(full).toContain('field14');
    expect(full).not.toContain('more fields');
  });

  it('reads the items through $ref and a nullable anyOf', () => {
    const schema = {
      type: 'object',
      properties: { rows: { anyOf: [{ type: 'array', items: { $ref: '#/$defs/Row' } }, { type: 'null' }] } },
      $defs: { Row: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    };
    const help = formatToolHelp(board('build_run', schema), ctx);
    expect(help).toContain('--rows   JSON array of objects with keys:\n    id     str · required\n');
  });

  it('lists the declared fields of an object parameter as --x.<field>, required ones marked', () => {
    const schema = {
      type: 'object',
      properties: { filter: { $ref: '#/$defs/Filter' } },
      $defs: { Filter: { type: 'object', properties: { state: { enum: ['open', 'closed'] }, per_page: { type: 'integer' } }, required: ['state'] } },
    };
    const help = formatToolHelp(board('build_run', schema), ctx);
    expect(help).toContain('\n  --filter.state      open|closed · required\n  --filter.per-page   num\n');
  });
});

describe('a list of scalars (discovery.md, "浏览视图")', () => {
  const ctx = ctxOf('board build:run', 'build_run');
  const sig = (properties: Record<string, object>, required: string[] = [], defs: object = {}) =>
    formatSignature(extractParams({ type: 'object', properties, required, $defs: defs } as never), 6, true);

  it('is written as the type of its items followed by [] in the signature and the usage line', () => {
    expect(sig({ todoIds: { type: 'array', items: { type: 'string' } }, ns: { type: 'array', items: { type: 'integer' } }, flags: { type: 'array', items: { type: 'boolean' } } }, ['todoIds'])).toBe(
      'todo-ids:str[], [ns:num[]], [flags:bool[]]',
    );
    expect(formatUsage(board('build_run', RUN), ctx)).toBe('usage: via board build:run --items <json> [--todo-ids <str[]>] [--_ <value>]');
  });

  it('keeps json for lists of objects or lists, tuples, and items the schema does not type', () => {
    expect(
      sig({
        a: { type: 'array', items: { type: 'object', properties: { x: {} } } },
        b: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        c: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] },
        d: { type: 'array', items: [{ type: 'string' }] },
        e: { type: 'array' },
        f: { type: 'array', items: {} },
      }),
    ).toBe('[a:json], [b:json], [c:json], [d:json], [e:json], [f:json]');
  });

  it('writes mixed scalar items in parentheses, and follows $ref and a nullable list', () => {
    const defs = { Tags: { type: 'array', items: { type: 'string' } } };
    expect(sig({ mixed: { type: 'array', items: { type: ['string', 'integer'] } }, ref: { $ref: '#/$defs/Tags' } }, [], defs)).toBe('[mixed:(str|num)[]], [ref:str[]]');
    expect(sig({ maybe: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] }, either: { type: ['array', 'string'], items: { type: 'string' } } })).toBe(
      '[maybe:str[]], [either:json|str]',
    );
  });

  it('counts the longer type in the 60 columns of a typed signature', () => {
    const name = 'a'.repeat(55);
    expect(sig({ [name]: { type: 'array', items: { type: 'object', properties: { x: {} } } } }, [name])).toBe(`${name}:json`);
    expect(sig({ [name]: { type: 'array', items: { type: 'string' } } }, [name])).toBe(name);
  });
});
