import type { NoiseRules } from './rules';

/**
 * Drop null, empty strings, empty arrays, empty objects and noise fields, recursively
 * (output.md, step 2). Returns undefined when nothing is left. `0` and `false` are data and stay.
 */
export function cleanValue(value: unknown, noise: NoiseRules): unknown {
  if (value === null || value === undefined || value === '') return undefined;
  if (Array.isArray(value)) {
    const items = value.map((v) => cleanValue(v, noise)).filter((v) => v !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === 'object') {
    const entries: Array<[string, unknown]> = [];
    for (const [key, v] of Object.entries(value)) {
      if (noise.isNoise(key)) continue;
      const cleaned = cleanValue(v, noise);
      if (cleaned !== undefined) entries.push([key, cleaned]);
    }
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  return value;
}
