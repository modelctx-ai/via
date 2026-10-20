import { describe, expect, it } from 'vitest';
import { defaultSplitRules, singularize } from '../../src/catalog';

const rules = defaultSplitRules();
const s = (w: string) => singularize(w, rules);

describe('singularize', () => {
  it.each([
    ['entries', 'entry'],
    ['repositories', 'repository'],
    ['branches', 'branch'],
    ['addresses', 'address'],
    ['hashes', 'hash'],
    ['boxes', 'box'],
    ['issues', 'issue'],
    ['logs', 'log'],
    ['databases', 'database'],
    ['pages', 'page'],
  ])('%s -> %s', (plural, singular) => {
    expect(s(plural)).toBe(singular);
  });

  it.each(['class', 'status', 'bonus', 'analysis', 'process', 'access', 'issue', 'log'])(
    'leaves %s alone',
    (w) => {
      expect(s(w)).toBe(w);
    },
  );

  it('honours the exception list from data/verbs.json', () => {
    for (const w of ['data', 'news', 'series', 'status', 'analytics', 'alias', 'aws']) expect(s(w)).toBe(w);
  });

  it('honours irregular plurals from data/verbs.json', () => {
    expect(s('statuses')).toBe('status');
    expect(s('aliases')).toBe('alias');
    expect(s('caches')).toBe('cache');
  });

  it('does not touch very short words', () => {
    expect(s('os')).toBe('os');
    expect(s('ps')).toBe('ps');
  });
});
