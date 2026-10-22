import { describe, expect, it } from 'vitest';
import {
  buildProviderCatalog,
  compileSplitRules,
  defaultCatalogRules,
  denyForms,
  findDenyRule,
  restoreProvider,
  snapshotProvider,
  type McpTool,
  type VerbsData,
} from '../../src/catalog';
import { loadTools } from '../helpers/fixtures';
import verbsData from '../../data/verbs.json';

// `deny` also matches a tool's leaf spelling (config.md "deny", naming.md "稳定性约定"): the name it
// has when it is not split into resource:verb. That spelling does not depend on the verb list, so
// changing the split rules can only keep or add matches for a rule written against a leaf name.

const tool = (name: string): McpTool => ({ name, inputSchema: { type: 'object' } });
const withVerbs = (extra: string[], without: string[] = []) => {
  const data = verbsData as VerbsData;
  return { ...defaultCatalogRules(), split: compileSplitRules({ ...data, verbs: [...data.verbs.filter((v) => !without.includes(v)), ...extra] }) };
};

describe('deny: the leaf spelling', () => {
  it('is the raw name minus the provider words, whatever the verb list says', () => {
    for (const raw of ['edit_file', 'filesystem_edit_file', 'edit_file_filesystem']) {
      for (const rules of [withVerbs(['edit']), withVerbs([], ['edit'])]) {
        const [t] = buildProviderCatalog({ provider: 'filesystem', tools: [tool(raw)] }, rules).tools;
        expect(t!.leafSingleRef, raw).toBe('filesystem/edit-file');
      }
    }
    expect(buildProviderCatalog({ provider: 'filesystem', tools: [tool('edit_file')] }, withVerbs(['edit'])).tools[0]!.name).toBe('file:edit');
    expect(buildProviderCatalog({ provider: 'filesystem', tools: [tool('edit_file')] }, withVerbs([], ['edit'])).tools[0]!.name).toBe('edit-file');
  });

  it('keeps hiding a tool that a verb-list change turns from a leaf into resource:verb', () => {
    const rule = /^filesystem\/edit-file$/;
    const before = buildProviderCatalog({ provider: 'filesystem', tools: [tool('edit_file'), tool('read_file')], deny: [rule] }, withVerbs([], ['edit']));
    const after = buildProviderCatalog({ provider: 'filesystem', tools: [tool('edit_file'), tool('read_file')], deny: [rule] }, withVerbs(['edit']));
    expect(before.tools.map((t) => t.rawName)).toEqual(['read_file']);
    expect(after.tools.map((t) => t.rawName)).toEqual(['read_file']);
    // and the tool really is `file:edit` now: the rule matched through the leaf spelling
    const shown = buildProviderCatalog({ provider: 'filesystem', tools: [tool('edit_file')] }, withVerbs(['edit']));
    expect(shown.tools[0]!.name).toBe('file:edit');
    expect(findDenyRule(shown.tools[0]!, [rule])).toContain('/^filesystem\\/edit-file$/');
  });

  it('on the real fixtures: the old leaf names of the tools the verb change split still deny them', () => {
    for (const [provider, raw, old] of [
      ['filesystem', 'edit_file', 'edit-file'],
      ['gmail', 'modify_message', 'modify-message'],
      ['notion', 'notion-download-skill', 'download-skill'],
      ['playwright', 'browser_install', 'browser-install'],
      ['sqlite', 'append_insight', 'append-insight'],
    ] as const) {
      const catalog = buildProviderCatalog({ provider, tools: loadTools('tools', provider), deny: [new RegExp(`^${provider}/${old}$`)] });
      expect(catalog.tools.map((t) => t.rawName), `${provider}/${old}`).not.toContain(raw);
    }
  });

  it('is one more form after the canonical, raw and default ones, listed once', () => {
    const [t] = buildProviderCatalog({ provider: 'acme', tools: [tool('create_issue')] }).tools;
    expect(denyForms(t!)).toEqual(['acme/issue:create', 'acme/create_issue', 'acme/create-issue']);
    const [leaf] = buildProviderCatalog({ provider: 'acme', tools: [tool('whoami')] }).tools;
    expect(denyForms(leaf!)).toEqual(['acme/whoami']);
    // a user rename does not change the leaf spelling
    const [renamed] = buildProviderCatalog({ provider: 'acme', tools: [tool('create_issue')], rename: { create_issue: 'ticket:open' } }).tools;
    expect(denyForms(renamed!)).toEqual(['acme/ticket:open', 'acme/create_issue', 'acme/issue:create', 'acme/create-issue']);
  });

  it('survives the prebuilt catalog: a restored tool has the same forms', () => {
    const tools = loadTools('tools', 'playwright');
    const built = buildProviderCatalog({ provider: 'playwright', tools });
    const { head, body } = snapshotProvider(built, tools);
    const restored = restoreProvider('playwright', head, body, () => tools, tools.length)!.catalog;
    expect(restored.tools.map((t) => denyForms(t))).toEqual(built.tools.map((t) => denyForms(t)));
    const install = restored.tools.find((t) => t.rawName === 'browser_install')!;
    expect(findDenyRule(install, [/^playwright\/browser-install$/])).toBeDefined();
  });
});
