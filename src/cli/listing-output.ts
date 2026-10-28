// What the browse views and `via find` share when they are asked for `-o json` or `-o raw`
// (output.md, "输出格式"). Light: the entry point of every browse command loads it.
import { shellWords } from '../render/shell';
import type { App } from './app';
import { usageFailure } from './failure';

/**
 * `-o raw` is the upstream's own text; a listing is made here, so there is none to give. Refused
 * rather than ignored (cli.md, "全局选项"): an output the caller asked for must not silently be another.
 * `words` are the arguments after `via`, for the `next:` line.
 */
export function rejectRaw(app: App, words: readonly string[]): void {
  if (app.options.format !== 'raw') return;
  throw usageFailure('-o raw applies to a tool call: a listing has no upstream text to show', `${words.length > 0 ? `via ${shellWords(words)}` : 'via'} -o json`);
}

const isScalar = (v: unknown): boolean => v === null || typeof v !== 'object';
const isFlat = (v: unknown): boolean => isScalar(v) || (Array.isArray(v) && v.every(isScalar));

/** `{"a": 1, "b": ["x", "y"]}` on one line. */
function inline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`).join(', ')}}`;
  return JSON.stringify(value) ?? 'null';
}

/**
 * JSON for a person or an agent to read as well as a program: two-space indentation, but a list of
 * scalars, and an object made of scalars and such lists, stay on one line while they fit in 100
 * columns (a signature is `{"required": ["owner", "repo"], "optional": []}`, not twelve lines).
 */
export function compactJson(value: unknown, depth = 0): string {
  const pad = '  '.repeat(depth);
  const flat = isScalar(value) || (Array.isArray(value) ? value.every(isScalar) : Object.values(value as object).every(isFlat));
  const one = inline(value);
  // A scalar has nothing to break, however long: below, a string would be taken apart as an object of its characters.
  if (isScalar(value) || (flat && pad.length + one.length <= 100)) return one;
  if (Array.isArray(value)) return `[\n${value.map((v) => `${pad}  ${compactJson(v, depth + 1)}`).join(',\n')}\n${pad}]`;
  const entries = Object.entries(value as object).map(([k, v]) => `${pad}  ${JSON.stringify(k)}: ${compactJson(v, depth + 1)}`);
  return `{\n${entries.join(',\n')}\n${pad}}`;
}

/**
 * A listing as JSON on stdout. Strings are server text (descriptions, names, allowed values), so
 * they are redacted like any content before they are written (output.md, "脱敏的范围").
 */
export async function writeJson(app: App, value: unknown): Promise<void> {
  app.out(`${compactJson(await app.redactValue(value))}\n`);
}
