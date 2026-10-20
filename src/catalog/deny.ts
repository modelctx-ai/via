// Matching `deny` rules against a tool (config.md, "deny"). The one place that decides which
// spellings a rule is tested on, shared by the catalog (hiding) and the CLI (refusing a call).
import type { CatalogTool } from './types';

/**
 * Longest spelling a rule is tested on. Rules are screened for catastrophic backtracking when the
 * config is loaded (`src/config/deny-safety.ts`); this bounds the input as well, so even a rule
 * with several open-ended quantifiers stays cheap. A tool whose spelling is longer is treated as
 * denied (fail closed) rather than matched.
 */
export const MAX_DENY_INPUT_LENGTH = 256;

/** The spellings of a tool that a rule is matched against. */
export function denyForms(tool: Pick<CatalogTool, 'provider' | 'rawName' | 'singleRef'>): string[] {
  return [tool.singleRef, `${tool.provider}/${tool.rawName}`];
}

/**
 * Why the tool is denied, as text for an error message, or undefined when no rule applies.
 * `g` / `y` flags make `RegExp#test` stateful; they are dropped so every test starts from 0.
 */
export function findDenyRule(tool: Pick<CatalogTool, 'provider' | 'rawName' | 'singleRef'>, rules: readonly RegExp[]): string | undefined {
  if (rules.length === 0) return undefined;
  const forms = denyForms(tool);
  if (forms.some((f) => f.length > MAX_DENY_INPUT_LENGTH)) {
    return `a deny rule (its name is longer than ${MAX_DENY_INPUT_LENGTH} characters, which deny rules cannot be checked against)`;
  }
  for (const rule of rules) {
    const plain = rule.global || rule.sticky ? new RegExp(rule.source, rule.flags.replace(/[gy]/g, '')) : rule;
    if (forms.some((f) => plain.test(f))) return `the deny rule ${rule.toString()}`;
  }
  return undefined;
}
