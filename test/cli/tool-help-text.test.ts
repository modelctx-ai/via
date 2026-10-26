// What a server's parameter names and descriptions turn into on the command line (arguments.md,
// "参数名", "调用示例", "帮助"; discovery.md, "浏览视图"): a parameter named `_`, an example without
// the parameters that say nothing, `-h --full`, the keys of an array of objects, and `str[]`.
import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN, ghConfig, makeSandbox, startFixtureServer, useCleanup } from './helpers';

const IGNORED = { description: 'Ignored.' };

const TOOLS = [
  { name: 'project_list', description: 'List the projects.', inputSchema: { type: 'object', properties: { _: IGNORED, reason: IGNORED }, additionalProperties: false } },
  {
    name: 'build_run',
    description: 'Run builds for cards.\n\nUse this only on the explicit request of the user.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'What to build.',
          items: { type: 'object', properties: { todoId: { type: 'string', description: 'The card to build' }, withPlan: { type: 'boolean' } }, required: ['todoId'] },
        },
        todoIds: { type: 'array', items: { type: 'string' } },
        _: IGNORED,
      },
      required: ['items'],
    },
  },
];

async function setup() {
  const srv = await startFixtureServer({ token: FAKE_TOKEN });
  useCleanup(() => srv.close());
  srv.state.tools = TOOLS;
  const sb = makeSandbox();
  sb.userConfig(ghConfig(srv.url));
  return { srv, sb };
}

describe('a parameter named _', () => {
  it('is written --_ in the usage line, in -h, and works as written', async () => {
    const { sb } = await setup();
    const help = await sb.via(['gh', 'project:list', '-h']);
    expect(help.stdout).toBe('usage: via gh project:list [--_ <value>] [--reason <value>]\n\nList the projects.\n  --_        Ignored.\n  --reason   Ignored.\nalias: project_list\n');
    const dry = await sb.via(['gh', 'project:list', '--_', 'x', '--dry-run', '-o', 'json']);
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true, args: { _: 'x' } });
    const wrong = await sb.via(['gh', 'project:list', '--', 'x']);
    expect(wrong.code).toBe(2);
    expect(wrong.stderr).toContain('unexpected argument "x"');
    expect(wrong.stderr).toContain('[--_ <value>]');
  });

  it('is in the signatures of the listing and of find', async () => {
    const { sb } = await setup();
    expect((await sb.via(['gh', 'project'])).stdout).toContain('[_], [reason]');
    const find = await sb.via(['find', 'project', '--brief']);
    expect(find.stdout).toContain('[_], [reason]');
    const json = JSON.parse((await sb.via(['gh', 'project', '-o', 'json'])).stdout) as Array<{ signature: { optional: string[] } }>;
    expect(json[0]!.signature.optional).toEqual(['_', 'reason']);
  });
});

describe('the example of find and of -h', () => {
  it('leaves out optional parameters that say nothing, the same in both', async () => {
    const { sb } = await setup();
    const help = (await sb.via(['gh', 'build:run', '-h'])).stdout;
    const example = /^example: (.*)$/m.exec(help)![1]!;
    expect(example).toBe(`via gh build:run --items '[{"todoId":"text"}]' --todo-ids text`);
    const find = JSON.parse((await sb.via(['find', 'build', '-o', 'json'])).stdout) as Array<{ ref: string; example?: string }>;
    expect(find.find((t) => t.ref === 'gh build:run')?.example).toBe(example);
    const listing = await sb.via(['find', 'project']);
    expect(listing.stdout).not.toContain('example:');
    expect(listing.stdout).not.toContain('--_');
  });
});

describe('-h and -h --full', () => {
  it('cuts the description, says so on a line before alias:, and prints everything with --full', async () => {
    const { sb } = await setup();
    const cut = await sb.via(['gh', 'build:run', '-h']);
    expect(cut.stdout).toContain('\nRun builds for cards.\n');
    expect(cut.stdout).not.toContain('explicit request');
    expect(cut.stdout.split('\n').slice(-3)).toEqual(['full text: via gh build:run -h --full', 'alias: build_run', '']);
    const full = await sb.via(['gh', 'build:run', '-h', '--full']);
    expect(full.code).toBe(0);
    expect(full.stdout).toContain('\nRun builds for cards.\n\nUse this only on the explicit request of the user.\n\n  --items');
    expect(full.stdout).not.toContain('full text:');
    // The option may stand before -h, and -o json is whole whatever is asked.
    expect((await sb.via(['gh', 'build:run', '--full', '-h'])).stdout).toBe(full.stdout);
    expect(JSON.parse((await sb.via(['gh', 'build:run', '-h', '-o', 'json'])).stdout).description).toContain('explicit request');
  });

  it('shows no hint when the text is whole', async () => {
    const { sb } = await setup();
    const help = await sb.via(['gh', 'project:list', '-h']);
    expect(help.stdout).not.toContain('full text:');
    expect((await sb.via(['gh', 'project:list', '-h', '--full'])).stdout).toBe(help.stdout);
  });
});

describe('arrays', () => {
  it('lists the keys of an array of objects and writes a list of strings as str[]', async () => {
    const { sb } = await setup();
    const help = (await sb.via(['gh', 'build:run', '-h', '--full'])).stdout;
    expect(help).toContain('usage: via gh build:run --items <json> [--todo-ids <str[]>] [--_ <value>]');
    expect(help).toContain('  --items      What to build. · JSON array of objects with keys:\n    todoId     str · required · The card to build\n    withPlan   bool\n');
    expect((await sb.via(['gh', 'build'])).stdout).toContain('items:json, [todo-ids:str[]]');
  });
});
