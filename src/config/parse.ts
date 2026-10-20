// Read-only parsing of config files. Parser libraries are imported on demand so that a run which
// only needs one format does not pay for the others (implementation.md, "启动速度").
//
// Error messages never quote the input: a parse error excerpt could contain a credential.

import type { ConfigFormat } from './frameworks';

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

export async function parseConfigText(text: string, format: ConfigFormat): Promise<unknown> {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  switch (format) {
    case 'json':
    case 'jsonc': {
      const jsonc = await import('jsonc-parser');
      const errors: import('jsonc-parser').ParseError[] = [];
      const options = format === 'json' ? { allowTrailingComma: false, disallowComments: true } : { allowTrailingComma: true, disallowComments: false };
      const value: unknown = jsonc.parse(source, errors, options);
      const first = errors[0];
      if (first) throw new ParseFailure(`invalid ${format.toUpperCase()}: ${jsonc.printParseErrorCode(first.error)} at ${lineCol(source, first.offset)}`);
      return value;
    }
    case 'toml': {
      const toml = await import('smol-toml');
      try {
        return toml.parse(source);
      } catch (error) {
        const e = error as { line?: number; column?: number };
        const where = typeof e.line === 'number' ? ` at line ${e.line}${typeof e.column === 'number' ? `, column ${e.column}` : ''}` : '';
        throw new ParseFailure(`invalid TOML${where}`);
      }
    }
    case 'yaml': {
      const yaml = await import('yaml');
      const doc = yaml.parseDocument(source, { prettyErrors: false });
      const first = doc.errors[0];
      if (first) throw new ParseFailure(`invalid YAML: ${first.code} at ${lineCol(source, first.pos[0])}`);
      return doc.toJS({ maxAliasCount: 100 }) as unknown;
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
