// A static guard for `deny` regular expressions (config.md, "deny"). Project configs can add rules,
// and a rule that backtracks catastrophically would stall every command that lists tools. V8 has
// no regex timeout, so rules that could take super-linear time on crafted input are refused
// instead: nested open-ended quantifiers, overlapping alternatives under a repeat,
// back-references, too many open-ended quantifiers, and over-long patterns. The check is
// conservative on purpose; ordinary deny rules (`^github/.*:delete$`, `^notion/page:(delete|move)$`)
// pass.

/** Longest accepted pattern, in characters. */
export const MAX_DENY_PATTERN_LENGTH = 200;
/** Most `*`, `+` and `{n,}` quantifiers one pattern may have (adjacent ones multiply the work). */
export const MAX_OPEN_ENDED_QUANTIFIERS = 3;

interface Branch {
  text: string;
  /** Only plain characters so far: the branch matches exactly `text`. */
  literal: boolean;
}

interface Frame {
  branches: Branch[];
  /** Contains an open-ended quantifier at any depth. */
  openEnded: boolean;
}

interface Quantifier {
  length: number;
  openEnded: boolean;
  /** Can repeat its atom more than once. */
  repeats: boolean;
}

const SPECIAL = new Set('\\^$.*+?()[]{}|');

function quantifierAt(pattern: string, i: number): Quantifier | undefined {
  const c = pattern[i];
  let q: Quantifier | undefined;
  if (c === '*' || c === '+') q = { length: 1, openEnded: true, repeats: true };
  else if (c === '?') q = { length: 1, openEnded: false, repeats: false };
  else if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i, i + 24));
    if (m) {
      const min = Number(m[1]);
      const open = m[2] !== undefined && m[3] === '';
      const max = m[2] === undefined ? min : open ? Infinity : Number(m[3]);
      q = { length: m[0].length, openEnded: open, repeats: max > 1 };
    }
  }
  if (q && pattern[i + q.length] === '?') q.length += 1; // lazy
  return q;
}

/** Why a pattern is refused, or undefined when it is acceptable. Expects a pattern that compiles. */
export function checkDenyPattern(pattern: string): string | undefined {
  if (pattern.length > MAX_DENY_PATTERN_LENGTH) return `longer than ${MAX_DENY_PATTERN_LENGTH} characters`;
  const stack: Frame[] = [{ branches: [{ text: '', literal: true }], openEnded: false }];
  const top = (): Frame => stack[stack.length - 1]!;
  const branch = (): Branch => top().branches[top().branches.length - 1]!;
  let openEnded = 0;

  /** A single atom was read; `quantified` marks it as not a plain literal. */
  const atom = (text: string | undefined, quantified: boolean): void => {
    const b = branch();
    if (text !== undefined && !quantified) b.text += text;
    else b.literal = false;
  };

  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '\\') {
      const next = pattern[i + 1] ?? '';
      if (/[1-9]/.test(next) || (next === 'k' && pattern[i + 2] === '<')) return 'back-references are not allowed';
      i += 2;
      const q = quantifierAt(pattern, i);
      if (q) {
        i += q.length;
        if (q.openEnded) {
          openEnded += 1;
          top().openEnded = true;
        }
      }
      atom(undefined, true);
      continue;
    }
    if (c === '[') {
      i += 1;
      if (pattern[i] === '^') i += 1;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      i += 1;
      const q = quantifierAt(pattern, i);
      if (q) {
        i += q.length;
        if (q.openEnded) {
          openEnded += 1;
          top().openEnded = true;
        }
      }
      atom(undefined, true);
      continue;
    }
    if (c === '(') {
      i += 1;
      if (pattern[i] === '?') {
        // (?: (?= (?! (?<= (?<! (?<name>
        const m = /^\?(?::|=|!|<=|<!|<[^>]*>)/.exec(pattern.slice(i, i + 80));
        i += m ? m[0].length : 1;
      }
      stack.push({ branches: [{ text: '', literal: true }], openEnded: false });
      continue;
    }
    if (c === ')') {
      i += 1;
      if (stack.length === 1) continue; // unbalanced; the pattern would not have compiled
      const group = stack.pop()!;
      const q = quantifierAt(pattern, i);
      if (q) i += q.length;
      if (q?.repeats) {
        if (group.openEnded) return 'a repeated group contains an open-ended quantifier (nested quantifiers can take exponential time)';
        if (group.branches.length > 1 && !prefixFreeLiterals(group.branches)) {
          return 'a repeated group has alternatives that can overlap (only distinct literal alternatives are allowed there)';
        }
      }
      if (q?.openEnded) openEnded += 1;
      if (group.openEnded || q?.openEnded) top().openEnded = true;
      atom(undefined, true);
      continue;
    }
    if (c === '|') {
      top().branches.push({ text: '', literal: true });
      i += 1;
      continue;
    }
    // A plain character, an anchor, `.`, or a quantifier on one of them.
    const isLiteral = !SPECIAL.has(c);
    i += 1;
    const q = quantifierAt(pattern, i);
    if (q) {
      i += q.length;
      if (q.openEnded) {
        openEnded += 1;
        top().openEnded = true;
      }
    }
    atom(isLiteral ? c : undefined, q !== undefined || !isLiteral);
  }
  if (openEnded > MAX_OPEN_ENDED_QUANTIFIERS) {
    return `more than ${MAX_OPEN_ENDED_QUANTIFIERS} open-ended quantifiers (*, +, {n,})`;
  }
  return undefined;
}

/** Every branch is a non-empty plain string and none is a prefix of another (or equal to it). */
function prefixFreeLiterals(branches: readonly Branch[]): boolean {
  if (branches.some((b) => !b.literal || b.text === '')) return false;
  for (const [i, a] of branches.entries()) {
    for (const [j, b] of branches.entries()) {
      if (i !== j && b.text.startsWith(a.text)) return false;
    }
  }
  return true;
}
