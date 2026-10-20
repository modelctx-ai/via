/**
 * Edit distance counting insertions, deletions, substitutions and adjacent transpositions
 * (optimal string alignment), so `raed` is one edit from `read`.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

/** Largest distance still considered "close" for an input of this length. */
export function closeness(input: string): number {
  return Math.max(1, Math.floor(input.length / 3));
}

/**
 * At most `max` candidates close to `input`, nearest first (discovery.md, "找不到时").
 * A candidate that starts with the input counts as close regardless of distance.
 */
export function didYouMean(input: string, candidates: readonly string[], max = 3): string[] {
  const limit = closeness(input);
  const scored: Array<[number, string]> = [];
  for (const c of new Set(candidates)) {
    const d = editDistance(input, c);
    if (d <= limit) scored.push([d, c]);
    else if (input.length >= 3 && c.startsWith(input)) scored.push([limit, c]);
  }
  scored.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return scored.slice(0, max).map(([, c]) => c);
}
