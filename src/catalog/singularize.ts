export interface SingularRules {
  /** Words that are returned unchanged. */
  exceptions: ReadonlySet<string>;
  /** Plural -> singular for forms the generic rules get wrong. */
  irregular: ReadonlyMap<string, string>;
}

/**
 * Deterministic English singularisation (naming.md, "单数化"). No dictionary lookups.
 */
export function singularize(word: string, rules: SingularRules): string {
  const w = word.toLowerCase();
  if (w.length <= 2) return w;
  if (rules.exceptions.has(w)) return w;
  const irregular = rules.irregular.get(w);
  if (irregular !== undefined) return irregular;
  if (w.endsWith('ies') && w.length > 3) return `${w.slice(0, -3)}y`;
  if (/(sses|shes|ches|xes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}
