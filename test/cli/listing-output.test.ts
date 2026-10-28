// `compactJson`, the JSON of the browse views and `via find` (listing-output.ts): pure, no server.
import { describe, expect, it } from 'vitest';
import { compactJson } from '../../src/cli/listing-output';

describe('compactJson', () => {
  it('writes the same value back, whatever the length of its strings', () => {
    // Server descriptions are often longer than the 100 columns a line may take; they were once written as
    // an object of their characters ({"0": "A", "1": "c", …}).
    const long = `${'Accept and merge changes at the review gate. '.repeat(4)}end`;
    for (const value of [long, { description: long }, [{ ref: 'gh issue:read', description: long }], { tools: [{ server: { instructions: long } }] }]) {
      expect(JSON.parse(compactJson(value))).toEqual(value);
    }
  });

  it('keeps a short object on one line and breaks a long one, one key per line', () => {
    expect(compactJson({ required: ['owner', 'repo'], optional: [] })).toBe('{"required": ["owner", "repo"], "optional": []}');
    const long = 'x'.repeat(120);
    expect(compactJson({ ref: 'gh issue:read', description: long })).toBe(`{\n  "ref": "gh issue:read",\n  "description": "${long}"\n}`);
  });
});
