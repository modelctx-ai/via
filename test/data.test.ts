import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../data/', import.meta.url));
const read = (rel: string): unknown => JSON.parse(readFileSync(join(root, rel), 'utf8'));

describe('data files validate against data/schema (data-files.md)', () => {
  const ajv = new Ajv({ allErrors: true, strict: true });
  it.each([
    ['verbs.json', 'schema/verbs.schema.json'],
    ['stopwords.json', 'schema/stopwords.schema.json'],
    ['destructive.json', 'schema/destructive.schema.json'],
    ['noise.json', 'schema/noise.schema.json'],
    ['columns.json', 'schema/columns.schema.json'],
    ['synonyms.json', 'schema/synonyms.schema.json'],
    ['common-flags.json', 'schema/common-flags.schema.json'],
  ])('%s', (file, schema) => {
    const validate = ajv.compile(read(schema) as object);
    const ok = validate(read(file));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('every verb is a single lower-case word; conjunctions are not verbs', () => {
    const { verbs, conjunctions } = read('verbs.json') as { verbs: string[]; conjunctions: string[] };
    expect(verbs.filter((v) => conjunctions.includes(v))).toEqual([]);
  });

  it('stop words are single lower-case words, and none of them is a verb of the table', () => {
    const { words } = read('stopwords.json') as { words: string[] };
    const { verbs } = read('verbs.json') as { verbs: string[] };
    expect(words.every((w) => /^[a-z0-9-]+$/.test(w))).toBe(true);
    expect(words.filter((w) => verbs.includes(w))).toEqual([]);
  });

  it('destructive words are single lower-case words that are not names of read operations', () => {
    const { words } = read('destructive.json') as { words: string[] };
    expect(words.every((w) => /^[a-z0-9]+$/.test(w))).toBe(true);
    const { verbs } = read('verbs.json') as { verbs: string[] };
    // Every word of the table that is also a verb is one the verb table splits on; none may be a read verb.
    for (const read of ['get', 'list', 'search', 'read', 'fetch', 'query', 'describe']) expect(words, read).not.toContain(read);
    expect(verbs).toContain('delete');
    expect(words).toContain('delete');
  });

  it('keeps the minimum verb set required by naming.md', () => {
    const { verbs } = read('verbs.json') as { verbs: string[] };
    for (const v of ['get', 'list', 'create', 'update', 'delete', 'search', 'send', 'run', 'fetch', 'read', 'write', 'add', 'remove', 'merge', 'trigger', 'query', 'move', 'duplicate', 'restore', 'cancel', 'navigate', 'click']) {
      expect(verbs, v).toContain(v);
    }
  });

  it('synonym groups are well formed (data-files.md, "synonyms.json")', () => {
    const data = read('synonyms.json') as { verbs: string[][]; resources: string[][]; queryStopwords: string[] };
    for (const group of [...data.verbs, ...data.resources]) {
      expect(new Set(group).size, group.join('/')).toBe(group.length);
      for (const member of group) expect(member, group.join('/')).toBe(member.toLowerCase());
    }
    // Query filler must not be a word the verb table treats as an action.
    const { verbs } = read('verbs.json') as { verbs: string[] };
    expect(data.queryStopwords.filter((w) => verbs.includes(w))).toEqual([]);
  });
});
