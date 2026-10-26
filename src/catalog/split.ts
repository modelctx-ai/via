import type { SplitRules } from './rules';
import { singularize } from './singularize';
import { tokenize } from './tokenize';

export interface SplitOptions {
  /** Provider name plus aliases; matching words are dropped from the tool name (naming.md, rule 2). */
  providerNames: readonly string[];
}

export type SplitResult =
  | { kind: 'resource'; resource: string; verb: string; /** Name to use if the tool falls back to a leaf. */ leafName: string }
  | { kind: 'leaf'; leafName: string };

/**
 * Drop words equal to a provider name from the start or end of the token list. `trailing` is what
 * was dropped from the end, in name order: the provider words that stood after the other words.
 */
export function stripProviderWords(tokens: string[], names: readonly string[]): { tokens: string[]; trailing: string[] } {
  const sequences = names
    .map((n) => tokenize(n))
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length);
  let current = tokens;
  let trailing: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const seq of sequences) {
      if (current.length <= seq.length) continue; // never strip everything
      if (seq.every((w, i) => current[i] === w)) {
        current = current.slice(seq.length);
        changed = true;
      } else if (seq.every((w, i) => current[current.length - seq.length + i] === w)) {
        current = current.slice(0, current.length - seq.length);
        trailing = [...seq, ...trailing];
        changed = true;
      }
    }
  }
  return { tokens: current, trailing };
}

/** Index range [start, end] of the verb chain (`create or update`) that contains `index`. */
function verbChain(tokens: string[], index: number, rules: SplitRules): [number, number] {
  let start = index;
  let end = index;
  while (end + 2 < tokens.length && rules.conjunctions.has(tokens[end + 1]!) && rules.verbs.has(tokens[end + 2]!)) {
    end += 2;
  }
  while (start - 2 >= 0 && rules.conjunctions.has(tokens[start - 1]!) && rules.verbs.has(tokens[start - 2]!)) {
    start -= 2;
  }
  return [start, end];
}

/** Locate the verb: first word, else last word, else first verb anywhere (naming.md, rule 3). */
function findVerb(tokens: string[], rules: SplitRules): [number, number] | undefined {
  let index = -1;
  if (rules.verbs.has(tokens[0]!)) index = 0;
  else if (rules.verbs.has(tokens[tokens.length - 1]!)) index = tokens.length - 1;
  else index = tokens.findIndex((t) => rules.verbs.has(t));
  if (index < 0) return undefined;
  return verbChain(tokens, index, rules);
}

/**
 * Split a raw MCP tool name into `resource:verb`, or a leaf tool (naming.md).
 * Pure and deterministic. Conflict handling (rule 6) happens at provider level.
 */
export function splitToolName(rawName: string, options: SplitOptions, rules: SplitRules): SplitResult {
  const all = tokenize(rawName);
  if (all.length === 0) return { kind: 'leaf', leafName: rawName.toLowerCase() };

  const { tokens, trailing } = stripProviderWords(all, options.providerNames);
  const leafName = tokens.join('-');

  const verbRange = findVerb(tokens, rules);
  if (!verbRange) return { kind: 'leaf', leafName };

  const [start, end] = verbRange;
  const verb = tokens.slice(start, end + 1).join('-');
  const resourceWords: string[] = [];
  // Only a verb (chain) is left and the provider name stood after it in the plural: it names the
  // resource the verb acts on, so it is kept (`close_todos` on `todos` -> `todo:close`). A provider
  // word in front of the verb is a namespace and a singular one is a brand; both stay dropped
  // (`notion-search`, `search_exa` are leaves) (naming.md, rule 2).
  const last = trailing[trailing.length - 1];
  const keep = tokens.length === end - start + 1 && last !== undefined && singularize(last, rules) !== last;
  const objects = keep ? trailing : [];
  for (const word of [...tokens.slice(0, start), ...tokens.slice(end + 1), ...objects]) {
    const singular = singularize(word, rules);
    if (resourceWords[resourceWords.length - 1] !== singular) resourceWords.push(singular);
  }
  if (resourceWords.length === 0) return { kind: 'leaf', leafName };
  return { kind: 'resource', resource: resourceWords.join('-'), verb, leafName };
}
