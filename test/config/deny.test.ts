import { describe, expect, it } from 'vitest';
import { buildProviderCatalog } from '../../src/catalog';
import { matchingDeny } from '../../src/cli/directory';
import { makeTree } from '../helpers/config';
import { loadTools } from '../helpers/fixtures';

// deny rules (config.md, "deny"; security.md): union of the layers, nobody below the user config can lift one.

/** The patterns as written (`RegExp.source` escapes slashes). */
const sources = (deny: readonly RegExp[]): string[] => deny.map((re) => re.source.replace(/\\\//g, '/'));

const USER = 'sources: false\ndeny: ["^github/.*:delete$", "^notion/page:(delete|move)$"]\n';

describe('deny: layers', () => {
  it('a project config only adds rules; an empty or null list removes nothing', async () => {
    for (const project of ['deny: []\n', 'deny:\n', 'deny: ["^extra/"]\n']) {
      const tree = makeTree({ 'home/.config/via/config.yaml': USER, 'project/.via.yaml': project });
      const patterns = sources((await tree.load()).deny);
      expect(patterns, project).toEqual(expect.arrayContaining(['^github/.*:delete$', '^notion/page:(delete|move)$']));
    }
  });

  it('the same pattern in two layers is one rule; order is user, project, command line', async () => {
    const tree = makeTree({
      'home/.config/via/config.yaml': USER,
      'project/.via.yaml': 'deny: ["^github/.*:delete$", "^proj/"]\n',
    });
    const config = await tree.load({ cliOverrides: { deny: ['^cli/', '^proj/'] } });
    expect(sources(config.deny)).toEqual(['^github/.*:delete$', '^notion/page:(delete|move)$', '^proj/', '^cli/']);
  });

  it('a project config cannot lift a rule by redefining a server, renaming or aliasing it', async () => {
    const tree = makeTree({
      'home/.config/via/config.yaml': `${USER}servers:\n  github:\n    url: https://gh.example.invalid/mcp\n`,
      'project/.via.yaml': 'deny: []\nservers:\n  github:\n    alias: gh\n    rename: { delete_file: "file:erase" }\n',
    });
    const config = await tree.load();
    expect(sources(config.deny)).toContain('^github/.*:delete$');
    // The raw-name spelling is matched too, so renaming a tool does not slip past a rule on its raw name.
    const rule = /^gh\/delete_file$/;
    const catalog = buildProviderCatalog({ provider: 'gh', tools: loadTools('tools', 'github'), rename: { delete_file: 'file:erase' }, deny: [rule] });
    expect(catalog.tools.some((t) => t.rawName === 'delete_file')).toBe(false);
  });

  it('a bad rule in the project config is an error and the good ones still apply', async () => {
    const tree = makeTree({ 'home/.config/via/config.yaml': USER, 'project/.via.yaml': 'deny: ["(", "^ok/"]\n' });
    const config = await tree.load();
    expect(sources(config.deny)).toEqual(['^github/.*:delete$', '^notion/page:(delete|move)$', '^ok/']);
    const bad = config.diagnostics.filter((d) => d.code === 'invalid-deny');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ level: 'error', file: expect.stringContaining('.via.yaml') });
  });

  it('a malformed user or project file is an error-level diagnostic too (the CLI stops rather than run without its rules)', async () => {
    for (const where of ['home/.config/via/config.yaml', 'project/.via.yaml']) {
      const tree = makeTree({ [where]: 'deny: [unclosed\n' });
      const config = await tree.load();
      expect(config.diagnostics.some((d) => d.level === 'error' && d.code === 'file-malformed'), where).toBe(true);
    }
  });

  it('a deny rule that is not a list of strings is reported, not silently dropped', async () => {
    const tree = makeTree({ 'home/.config/via/config.yaml': 'deny: "^a$"\n' });
    const config = await tree.load();
    expect(config.diagnostics.map((d) => `${d.level}:${d.code}`)).toContain('error:invalid-field');
  });
});

describe('deny: matching', () => {
  const tools = loadTools('tools', 'github');
  const names = (deny: RegExp[]): string[] => buildProviderCatalog({ provider: 'github', tools, deny }).tools.map((t) => t.rawName);
  const all = names([]);

  it('matches the single-string spelling and the raw name', () => {
    const [victim] = buildProviderCatalog({ provider: 'github', tools }).tools.filter((t) => t.rawName === 'delete_file');
    expect(victim).toBeDefined();
    expect(names([new RegExp(`^${victim!.singleRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)])).not.toContain('delete_file');
    expect(names([/^github\/delete_file$/])).not.toContain('delete_file');
    expect(names([/^github\/delete_file$/])).toHaveLength(all.length - 1);
  });

  it('is an unanchored regular expression: anchors are the author\'s job', () => {
    expect(names([/delete/]).some((n) => n.includes('delete'))).toBe(false);
    expect(names([/^github\/$/])).toHaveLength(all.length);
  });

  it('is case sensitive and never matches other providers', () => {
    expect(names([/^GITHUB\//i])).toHaveLength(0);
    expect(names([/^GITHUB\//])).toHaveLength(all.length);
    expect(names([/^notion\//])).toHaveLength(all.length);
  });

  it('is stateless: a global or sticky flag does not make the answer depend on earlier tests', () => {
    const catalog = buildProviderCatalog({ provider: 'github', tools });
    const tool = catalog.tools[0]!;
    const re = new RegExp(`^${tool.provider}/`, 'g');
    for (let i = 0; i < 3; i += 1) expect(matchingDeny(tool, [re])).toBeDefined();
    expect(names([new RegExp('^github/', 'gy')])).toHaveLength(0);
  });

  it('hides a tool whose name is too long to check, as soon as any rule exists (fail closed)', () => {
    const long = { name: `tool_${'x'.repeat(300)}`, inputSchema: { type: 'object' as const } };
    const open = buildProviderCatalog({ provider: 'github', tools: [long] });
    expect(open.tools).toHaveLength(1);
    expect(buildProviderCatalog({ provider: 'github', tools: [long], deny: [/^never$/] }).tools).toHaveLength(0);
    expect(matchingDeny(open.tools[0]!, [/^never$/])).toMatch(/longer than 256/);
  });

  it('stays fast on crafted names with a rule that passed the safety check', () => {
    const crafted = { name: `${'a'.repeat(200)}!`, inputSchema: { type: 'object' as const } };
    const started = Date.now();
    buildProviderCatalog({ provider: 'github', tools: [crafted], deny: [/^.*.*.*b$/] });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
