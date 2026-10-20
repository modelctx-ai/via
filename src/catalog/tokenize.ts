/**
 * Split an identifier into lower-case words on `_`, `-`, `.`, whitespace and camelCase boundaries
 * (naming.md, rule 1). `getHTTPResponse` -> [get, http, response].
 */
export function tokenize(name: string): string[] {
  return name
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** kebab-case spelling of an identifier. */
export function kebab(name: string): string {
  return tokenize(name).join('-');
}
