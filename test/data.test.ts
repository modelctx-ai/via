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
    ['domains.json', 'schema/domains.schema.json'],
    ['domain-lexicon.json', 'schema/domain-lexicon.schema.json'],
    ['noise.json', 'schema/noise.schema.json'],
    ['columns.json', 'schema/columns.schema.json'],
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

  it('keeps the minimum verb set required by naming.md', () => {
    const { verbs } = read('verbs.json') as { verbs: string[] };
    for (const v of ['get', 'list', 'create', 'update', 'delete', 'search', 'send', 'run', 'fetch', 'read', 'write', 'add', 'remove', 'merge', 'trigger', 'query', 'move', 'duplicate', 'restore', 'cancel', 'navigate', 'click']) {
      expect(verbs, v).toContain(v);
    }
  });

  it('every domain in the built-in table has at least one server and the lexicon only names known domains', () => {
    const domains = read('domains.json') as { domains: Record<string, { servers: string[] }> };
    for (const [name, d] of Object.entries(domains.domains)) expect(d.servers.length, name).toBeGreaterThan(0);
    const lexicon = read('domain-lexicon.json') as { terms: Record<string, Record<string, number>> };
    const known = new Set(Object.keys(domains.domains));
    for (const [term, weights] of Object.entries(lexicon.terms)) {
      for (const domain of Object.keys(weights)) expect(known.has(domain), `${term} -> ${domain}`).toBe(true);
    }
  });
});
