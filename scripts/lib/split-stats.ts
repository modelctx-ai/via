// The measurement behind `npm run split-stats` (scripts/split-stats.ts): for one provider, which
// tools end up as leaf tools and why. Uses the catalog code itself, so it cannot drift from what
// the CLI does.
import { buildProviderCatalog, splitToolName } from '../../src/catalog';
import type { CatalogRules, McpTool } from '../../src/catalog';

/** Why a tool ended up as a leaf. */
export type Reason =
  /** No word of the name is in the verb list (naming.md rule 3). */
  | 'no-verb'
  /** A verb was found but no resource word is left (`search`, `list_all` -> verb only). */
  | 'verb-only'
  /** Two tools split to the same `resource:verb` (rule 6). */
  | 'conflict'
  /** The resource shares its name with a leaf whose raw name is that name (rule 7). */
  | 'shadowed';

export const REASONS: readonly Reason[] = ['no-verb', 'verb-only', 'conflict', 'shadowed'];
export const WHY: Record<Reason, string> = {
  'no-verb': '名字里没有动词表中的词（规则 3 找不到动作）',
  'verb-only': '找到动词但没有剩余的词可作资源（只有动作）',
  conflict: '两个工具拆出相同的 `资源:动作`，都退回为叶子（规则 6）',
  shadowed: '资源与一个原始名恰为该名字的叶子同名，资源让出名字（规则 7）',
};

export interface LeafInfo {
  raw: string;
  /** Canonical name after provider words are dropped (what the leaf is called). */
  name: string;
  reason: Reason;
  /** For `conflict`: the `resource:verb` both tools wanted. For `shadowed`: the resource that yielded. */
  detail?: string;
}

export interface ServerStats {
  server: string;
  tools: number;
  /** Tools the split rules alone turn into `resource:verb`. */
  split: number;
  leaves: LeafInfo[];
}

/** Split one provider's tools with `rules` and classify every tool that ends up as a leaf. */
export function measureProvider(server: string, tools: McpTool[], rules: CatalogRules): ServerStats {
  const catalog = buildProviderCatalog({ provider: server, tools }, rules);
  const leaves: LeafInfo[] = [];
  let split = 0;
  const wanted = new Map<string, number>();
  const bySplit = new Map<string, ReturnType<typeof splitToolName>>();
  for (const tool of tools) {
    const result = splitToolName(tool.name, { providerNames: [server] }, rules.split);
    bySplit.set(tool.name, result);
    if (result.kind === 'resource') {
      split += 1;
      const key = `${result.resource}:${result.verb}`;
      wanted.set(key, (wanted.get(key) ?? 0) + 1);
    }
  }
  for (const final of catalog.tools) {
    if (final.resource !== null) continue;
    const result = bySplit.get(final.rawName)!;
    if (result.kind === 'leaf') {
      const hasVerb = result.leafName.split('-').some((word) => rules.split.verbs.has(word));
      leaves.push({ raw: final.rawName, name: final.name, reason: hasVerb ? 'verb-only' : 'no-verb' });
    } else {
      const key = `${result.resource}:${result.verb}`;
      const clash = (wanted.get(key) ?? 0) > 1;
      leaves.push({ raw: final.rawName, name: final.name, reason: clash ? 'conflict' : 'shadowed', detail: clash ? key : result.resource });
    }
  }
  return { server, tools: tools.length, split, leaves };
}
