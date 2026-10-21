// A framework entry that starts `via serve` is via itself (ADR 0016): reading it as a server would
// make via start itself, and that copy would read the same file. Such entries are left out.
import type { ServerDef } from './model';

/** `via`, `via.exe`, `via.cmd`, a `via.js` entry script, or the npm package (`@modelctx-ai/via@1.2`). */
function isVia(word: string): boolean {
  if (/^@modelctx-ai\/via(@|$)/i.test(word)) return true;
  const base = word.split(/[\\/]/).pop()!.toLowerCase();
  return /^via(\.(exe|cmd|bat|js|mjs|cjs))?$/.test(base);
}

/** True for a stdio definition whose command line runs `via … serve`. */
export function startsViaServe(def: ServerDef): boolean {
  if (def.command === undefined) return false;
  const words = [def.command, ...(def.args ?? [])];
  const serve = words.indexOf('serve', 1);
  return serve > 0 && words.slice(0, serve).some(isVia);
}
