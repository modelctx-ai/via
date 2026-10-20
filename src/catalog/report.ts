import { alignRows } from '../render/width';
import type { ProviderCatalog } from './types';

/**
 * One line per tool: `raw name -> canonical tool part`, leaf tools marked. Used by the offline
 * split check (naming.md, "稳定性约定") and by split snapshot tests.
 */
export function formatSplitTable(provider: ProviderCatalog): string {
  const rows = provider.tools.map((t) => [t.rawName, '→', t.resource === null ? `${t.name}  (leaf)` : t.name]);
  return `${alignRows(rows).join('\n')}\n`;
}
