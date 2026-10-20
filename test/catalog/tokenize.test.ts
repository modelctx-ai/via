import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kebab, tokenize } from '../../src/catalog/tokenize';

// The regular-expression implementation the ASCII fast path replaced: the two must agree.
function reference(name: string): string[] {
  return name
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

describe('tokenize', () => {
  it('splits on separators and camelCase boundaries', () => {
    expect(tokenize('getHTTPResponse')).toEqual(['get', 'http', 'response']);
    expect(tokenize('create_issue-comment.v2')).toEqual(['create', 'issue', 'comment', 'v2']);
    expect(tokenize('listPRs')).toEqual(reference('listPRs'));
    expect(tokenize('')).toEqual([]);
    expect(tokenize('___')).toEqual([]);
    expect(kebab('issueNumber')).toBe('issue-number');
  });

  it('agrees with the regular-expression version on random ASCII strings', () => {
    const alphabet = 'abcXYZ019_-. :/ABcdEFgH';
    let state = 12345;
    const next = (): number => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state >>> 8;
    };
    for (let i = 0; i < 20_000; i += 1) {
      const length = next() % 14;
      let s = '';
      for (let j = 0; j < length; j += 1) s += alphabet[next() % alphabet.length];
      expect(tokenize(s), JSON.stringify(s)).toEqual(reference(s));
    }
  });

  it('agrees on non-ASCII names, which take the Unicode path', () => {
    for (const s of ['Été_créé', 'ÀbcDéf', 'データ取得', 'naïveBayes', 'Straße-Größe', 'a１B２', 'ÉCOLEPrimaire']) {
      expect(tokenize(s), s).toEqual(reference(s));
    }
  });

  it('agrees on every tool and parameter name in the fixtures', () => {
    const dir = join(import.meta.dirname, '..', 'fixtures', 'tools');
    let names = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const tools = (JSON.parse(readFileSync(join(dir, file), 'utf8')) as { tools: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> }).tools;
      for (const tool of tools) {
        for (const name of [tool.name, ...Object.keys(tool.inputSchema?.properties ?? {})]) {
          expect(tokenize(name), name).toEqual(reference(name));
          names += 1;
        }
      }
    }
    expect(names).toBeGreaterThan(300);
  });
});
