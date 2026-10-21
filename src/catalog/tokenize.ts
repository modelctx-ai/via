// Compiled on first use: Unicode property escapes make these expensive to build, and an ASCII
// identifier (nearly every tool and parameter name) never needs them.
let boundaries: RegExp[] | undefined;
let separators: RegExp | undefined;

/** The general case, for names with non-ASCII letters or digits. */
function tokenizeUnicode(name: string): string[] {
  boundaries ??= [/(\p{Ll}|\p{N})(\p{Lu})/gu, /(\p{Lu}+)(\p{Lu}\p{Ll})/gu];
  separators ??= /[^\p{L}\p{N}]+/u;
  return name
    .replace(boundaries[0]!, '$1 $2')
    .replace(boundaries[1]!, '$1 $2')
    .split(separators)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * ASCII fast path with the same result as the Unicode one: a word ends at any character that is
 * not a letter or digit, between a lower-case letter or digit and an upper-case letter
 * (`getHTTP` -> get, http), and before the last capital of a run that is followed by a lower-case
 * letter (`HTTPResponse` -> http, response). Returns undefined when `name` is not ASCII.
 */
function tokenizeAscii(name: string): string[] | undefined {
  const words: string[] = [];
  let start = -1;
  const length = name.length;
  for (let i = 0; i < length; i += 1) {
    const c = name.charCodeAt(i);
    if (c > 127) return undefined;
    const upper = c >= 65 && c <= 90;
    const alnum = upper || (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
    if (!alnum) {
      if (start >= 0) {
        words.push(name.slice(start, i));
        start = -1;
      }
      continue;
    }
    if (start < 0) {
      start = i;
      continue;
    }
    if (upper) {
      const prev = name.charCodeAt(i - 1);
      const next = i + 1 < length ? name.charCodeAt(i + 1) : 0;
      const prevUpper = prev >= 65 && prev <= 90;
      const nextLower = next >= 97 && next <= 122;
      // lower-case or digit before a capital, or a capital run that ends before a lower-case letter
      if (!prevUpper || nextLower) {
        words.push(name.slice(start, i));
        start = i;
      }
    }
  }
  if (start >= 0) words.push(name.slice(start));
  return words.map((w) => w.toLowerCase());
}

/**
 * Split an identifier into lower-case words on `_`, `-`, `.`, whitespace and camelCase boundaries
 * (naming.md, rule 1). `getHTTPResponse` -> [get, http, response].
 */
export function tokenize(name: string): string[] {
  return tokenizeAscii(name) ?? tokenizeUnicode(name);
}

/** kebab-case spelling of an identifier. */
export function kebab(name: string): string {
  return tokenize(name).join('-');
}
