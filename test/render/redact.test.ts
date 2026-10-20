import { describe, expect, it } from 'vitest';
import {
  cleanValue,
  createRedactor,
  defaultNoise,
  MemoryCursorStore,
  redactValue,
  renderMore,
  renderOptions,
  renderToolResult,
} from '../../src/render';
import { FAKE_SECRET, makeContext, plainText, render, sequentialIds, structured } from '../helpers/render';
import { manyRows } from '../fixtures/results';


describe('credential redaction (output.md, step 6; AGENTS.md safety rules)', () => {
  it('replaces exact matches with ***', () => {
    const redact = createRedactor([FAKE_SECRET]);
    expect(redact(`Bearer ${FAKE_SECRET} and again ${FAKE_SECRET}`)).toBe('Bearer *** and again ***');
  });

  it('handles several secrets, longest first, and ignores empty ones', () => {
    const redact = createRedactor(['abcd', 'abcdefgh', '']);
    expect(redact('x abcdefgh y abcd z')).toBe('x *** y *** z');
  });

  it('also catches the JSON-escaped spelling of a secret', () => {
    const secret = 'pa"ss\\word-0123456789';
    const redact = createRedactor([secret]);
    expect(redact(JSON.stringify({ k: secret }))).toBe('{"k":"***"}');
  });

  it('redacts inside nested structures, keys included', () => {
    const redact = createRedactor([FAKE_SECRET]);
    expect(redactValue({ [FAKE_SECRET]: [FAKE_SECRET, { a: `x${FAKE_SECRET}y` }], n: 1 }, redact)).toEqual({
      '***': ['***', { a: 'x***y' }],
      n: 1,
    });
  });

  const asText = (r: Awaited<ReturnType<typeof render>>) => r.stdout + r.stderr;

  it('never prints the secret in text, json or raw output', async () => {
    const results = [
      structured({ id: 1, auth: `Bearer ${FAKE_SECRET}`, nested: { echoed: FAKE_SECRET } }),
      structured([{ id: 1, v: FAKE_SECRET }, { id: 2, v: 'ok' }]),
      plainText(`token=${FAKE_SECRET}`),
    ];
    for (const format of ['text', 'json', 'raw'] as const) {
      for (const result of results) {
        const out = await render(result, { format, secrets: [FAKE_SECRET] });
        expect(asText(out), format).not.toContain(FAKE_SECRET);
        expect(asText(out), format).toContain('***');
      }
    }
  });

  it('redacts before cutting table cells, so a cut cannot leave half a secret', async () => {
    const long = `${'p'.repeat(70)}${FAKE_SECRET}${'s'.repeat(30)}`;
    const out = await render(structured([{ id: 1, v: long }, { id: 2, v: 'x' }]), { secrets: [FAKE_SECRET], cellWidth: 80 });
    expect(out.stdout).not.toContain(FAKE_SECRET.slice(0, 8));
    expect(out.stdout).toContain('***');
  });

  it('keeps secrets out of stored cursors', async () => {
    const cursors = new MemoryCursorStore({ generateId: sequentialIds() });
    const rows = manyRows.map((r, i) => ({ ...r, note: i === 40 ? `leak ${FAKE_SECRET}` : 'fine' }));
    const ctx = makeContext({ cursors });
    const first = await renderToolResult(structured(rows), renderOptions({ budget: 500, secrets: [FAKE_SECRET] }), ctx);
    const record = await cursors.get('c7f2');
    expect(JSON.stringify(record)).not.toContain(FAKE_SECRET);
    expect(first.stdout).not.toContain(FAKE_SECRET);
    // and not in later pages either
    const next = await renderMore('c7f2', ctx, { format: 'text', secrets: [FAKE_SECRET] });
    expect(next.stdout + next.stderr).not.toContain(FAKE_SECRET);
  });
});

describe('cleanValue', () => {
  it('is pure: the input is not modified', () => {
    const input = { a: null, b: { c: '', d: 1 }, node_id: 'x' };
    const copy = structuredClone(input);
    cleanValue(input, defaultNoise());
    expect(input).toEqual(copy);
  });
});
