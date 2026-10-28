import { terminalWidth } from './terminal-width';

/** Display width in terminal columns; CJK characters count as two. */
export function displayWidth(s: string): number {
  return terminalWidth(s);
}

export function padEndWidth(s: string, width: number): string {
  const gap = width - displayWidth(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

/**
 * Left-align `rows` into columns separated by `gap` spaces. Widths use display width, and the
 * last column is not padded so lines carry no trailing whitespace.
 */
export function alignRows(rows: readonly (readonly string[])[], gap = 2): string[] {
  const columns = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const widths = Array.from({ length: columns }, (_, c) =>
    rows.reduce((w, r) => Math.max(w, displayWidth(r[c] ?? '')), 0),
  );
  return rows.map((r) =>
    r
      .map((cell, c) => (c === r.length - 1 ? cell : padEndWidth(cell, widths[c]! + gap)))
      .join('')
      .trimEnd(),
  );
}

/** Truncate to at most `max` characters (code points), ending with `…` when cut. */
/** `1 tool`, `3 tools`: a count and an English noun that takes `s`. */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function truncateChars(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}…` : s;
}
