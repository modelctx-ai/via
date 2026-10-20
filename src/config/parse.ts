// Read-only parsing of config files. Parser libraries are imported on demand so that a run which
// only needs one format does not pay for the others (implementation.md, "启动速度").
//
// Error messages never quote the input: a parse error excerpt could contain a credential.

import type { ConfigFormat } from './frameworks';
import type { ParseCache } from './parse-cache';

export class ParseFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseFailure';
  }
}

function lineCol(text: string, offset: number): string {
  const before = text.slice(0, Math.max(0, offset));
  const line = before.split('\n').length;
  const col = offset - (before.lastIndexOf('\n') + 1) + 1;
  return `line ${line}, column ${col}`;
}

/**
 * A CommonJS package imported from the bundle (tsup splits it into its own chunk) has no named
 * exports there, only `default`; imported from Node's own loader both exist and agree.
 */
function interop<T extends object>(mod: T): T {
  return (mod as { default?: T }).default ?? mod;
}

export interface ParseOptions {
  /** Where parsed YAML is kept (parse-cache.ts); other formats are never cached. */
  cache?: ParseCache;
  /** SHA-256 of the file's bytes, the cache key. Called only when there is a cache and the file is YAML. */
  key?: () => string;
}

export async function parseConfigText(text: string, format: ConfigFormat, options: ParseOptions = {}): Promise<unknown> {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  switch (format) {
    case 'json':
    case 'jsonc': {
      // Valid strict JSON (nearly every framework config, and most "JSONC" ones) needs no parser
      // library: JSON.parse is native, it means the same in both formats, and it stores a
      // "__proto__" key as an own property instead of assigning it. Anything it rejects (comments,
      // trailing commas, a syntax error) goes through jsonc-parser, which also words the error.
      try {
        return JSON.parse(source) as unknown;
      } catch {
        // fall through
      }
      const jsonc = interop(await import('jsonc-parser'));
      const errors: import('jsonc-parser').ParseError[] = [];
      const options = format === 'json' ? { allowTrailingComma: false, disallowComments: true } : { allowTrailingComma: true, disallowComments: false };
      const value: unknown = jsonc.parse(source, errors, options);
      const first = errors[0];
      if (first) throw new ParseFailure(`invalid ${format.toUpperCase()}: ${jsonc.printParseErrorCode(first.error)} at ${lineCol(source, first.offset)}`);
      return value;
    }
    case 'toml': {
      const toml = interop(await import('smol-toml'));
      try {
        return toml.parse(source);
      } catch (error) {
        const e = error as { line?: number; column?: number };
        const where = typeof e.line === 'number' ? ` at line ${e.line}${typeof e.column === 'number' ? `, column ${e.column}` : ''}` : '';
        throw new ParseFailure(`invalid TOML${where}`);
      }
    }
    case 'yaml': {
      const key = options.cache && options.key ? options.key() : undefined;
      if (key !== undefined) {
        const hit = options.cache!.get(key, source);
        if (hit) return hit.value;
      }
      const yaml = interop(await import('yaml'));
      const doc = yaml.parseDocument(source, { prettyErrors: false });
      const first = doc.errors[0];
      if (first) throw new ParseFailure(`invalid YAML: ${first.code} at ${lineCol(source, first.pos[0])}`);
      const value = doc.toJS({ maxAliasCount: 100 }) as unknown;
      if (key !== undefined) options.cache!.put(key, source, doc.contents, value, yaml);
      return value;
    }
  }
}

/** Resolve an RFC 6901 JSON Pointer. A missing target is `{ found: false }`, not an error. */
export function resolvePointer(doc: unknown, pointer: string): { found: true; value: unknown } | { found: false } {
  if (pointer === '') return { found: true, value: doc };
  if (!pointer.startsWith('/')) return { found: false };
  let current: unknown = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) return { found: false };
    current = (current as Record<string, unknown>)[key];
  }
  return { found: true, value: current };
}
