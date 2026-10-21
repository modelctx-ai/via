import { describe, expect, it } from 'vitest';
import {
  cleanValue,
  createRedactor,
  defaultNoise,
  MemoryCursorStore,
  MemoryMediaSink,
  redactProtocol,
  redactValue,
  renderMore,
  renderOptions,
  renderToolResult,
} from '../../src/render';
import type { ToolResult } from '../../src/render';
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

  it('redacts inside nested structures; a long credential in a key goes too', () => {
    const redact = createRedactor([FAKE_SECRET]);
    expect(redactValue({ [FAKE_SECRET]: [FAKE_SECRET, { a: `x${FAKE_SECRET}y` }], n: 1 }, redact)).toEqual({
      '***': ['***', { a: 'x***y' }],
      n: 1,
    });
  });

  it('short credentials are replaced in values only: keys, numbers and booleans stay', () => {
    const redact = createRedactor(['x', 'true', '1']);
    expect(redactValue({ text: 'a x b', next: { type: 'text', n: 1, ok: true, tags: ['x', 'y'] } }, redact)).toEqual({
      text: 'a *** b',
      next: { type: 'te***t', n: 1, ok: true, tags: ['***', 'y'] },
    });
    // As a function, a redactor treats a string as content; `key` and `scan` leave short values alone.
    expect(redact.key('text')).toBe('text');
    expect(redact.scan('error: next: x 1 true')).toBe('error: next: x 1 true');
  });

  it('scan and key still catch long credentials', () => {
    const redact = createRedactor([FAKE_SECRET, 'x']);
    expect(redact.scan(`next: ${FAKE_SECRET}`)).toBe('next: ***');
    expect(redact.key(`k-${FAKE_SECRET}`)).toBe('k-***');
  });

  it('redactProtocol keeps the protocol fields and the base64 payloads, and redacts the content', () => {
    const redact = createRedactor(['x', 'text', 'e']);
    const result = {
      content: [
        { type: 'text', text: 'a text x' },
        { type: 'image', data: 'eHh4eA==', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///x', mimeType: 'text/plain', text: 'x', blob: 'eHg=' } },
        { type: 'resource_link', uri: 'file:///x', name: 'x.txt', mimeType: 'text/plain' },
      ],
      structuredContent: { type: 'text', data: 'x', text: 'x' },
      isError: false,
    };
    expect(redactProtocol(result, redact)).toEqual({
      content: [
        { type: 'text', text: 'a *** ***' },
        { type: 'image', data: 'eHh4eA==', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'fil***:///***', mimeType: 'text/plain', text: '***', blob: 'eHg=' } },
        { type: 'resource_link', uri: 'fil***:///***', name: '***.t***t', mimeType: 'text/plain' },
      ],
      // Free-form data gets no exemption: a field called `type` is the server's own.
      structuredContent: { type: '***', data: '***', text: '***' },
      isError: false,
    });
  });

  it('messages: role stays, content is redacted', () => {
    const redact = createRedactor(['a']);
    expect(redactProtocol({ description: 'a prompt', messages: [{ role: 'assistant', content: { type: 'text', text: 'banana' } }] }, redact)).toEqual({
      description: '*** prompt',
      messages: [{ role: 'assistant', content: { type: 'text', text: 'b***n***n***' } }],
    });
  });

  const asText = (r: Awaited<ReturnType<typeof render>>) => r.stdout + r.stderr;

  it('renders a result whose content blocks and keys contain the credential, in every format', async () => {
    const secrets = ['x', 'text', 'type', 'content', 'json', '1', 'true'];
    for (const secret of secrets) {
      const result = structured({ text: `a ${secret} b`, items: [{ type: 'note', id: 1, ok: true }], mimeType: 'text/plain' });
      const json = await render(result, { format: 'json', secrets: [secret] });
      const value = JSON.parse(json.stdout) as Record<string, unknown>;
      expect(Object.keys(value), secret).toEqual(['text', 'items', 'mimeType']);
      expect(value.text).toBe(`a ${secret} b`.split(secret).join('***'));
      const text = await render(result, { format: 'text', secrets: [secret] });
      expect(text.exitCode, secret).toBe(0);
      expect(text.stdout, secret).toContain('items:');
      const raw = await render(plainText(`token ${secret}`), { format: 'raw', secrets: [secret] });
      expect(raw.stdout, secret).toBe(`${`token ${secret}`.split(secret).join('***')}\n`);
    }
  });

  it('a saved file keeps its path whatever the credential is', async () => {
    const media = new MemoryMediaSink('/cache/media');
    const png: ToolResult = { content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] };
    const plain = await render(png, { secrets: ['a', 'e', '0', 'c', '/', 'png'] }, { media });
    expect(plain.stdout).toMatch(/^\/cache\/media\/[0-9a-f]{12}\.png\n$/);
    const json = await render(png, { format: 'json', secrets: ['a', 'e', '0', 'c', '/', 'png', 'type', 'image'] }, { media });
    expect(JSON.parse(json.stdout)).toEqual({ type: 'image', path: expect.stringMatching(/^\/cache\/media\/[0-9a-f]{12}\.png$/) });
  });

  it('an upstream error keeps its labels and JSON envelope', async () => {
    const error: ToolResult = { content: [{ type: 'text', text: 'boom: the upstream failed' }], isError: true };
    // The labels are ours: only the upstream text is content.
    const text = await render(error, { secrets: ['o'] });
    expect(text.stderr).toBe('error: b******m: the upstream failed\nnext: via github issue:list -h\n');
    const json = await render(error, { format: 'json', secrets: ['e', 'r', 'o', 'code', 'message'] });
    const parsed = JSON.parse(json.stderr) as { error: Record<string, unknown> };
    expect(Object.keys(parsed.error)).toEqual(['code', 'message', 'next']);
    expect(parsed.error.next).toBe('via github issue:list -h');
  });

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

  it('stored cursors: a short credential is redacted in the cells, and the header and the cursor id are intact', async () => {
    const cursors = new MemoryCursorStore({ generateId: sequentialIds() });
    const rows = manyRows.map((r, i) => ({ ...r, note: i === 40 ? 'leak x leak' : 'fine' }));
    const ctx = makeContext({ cursors });
    const first = await renderToolResult(structured(rows), renderOptions({ budget: 500, secrets: ['x'] }), ctx);
    const record = await cursors.get('c7f2');
    expect(record!.header.join('\n')).toMatch(/^id\s+name\s+status\s+region\s+note/);
    expect(record!.lines.join('\n')).toContain('leak *** leak');
    expect(first.stderr).toContain('next: via more c7f2');
    const next = await renderMore('c7f2', ctx, { format: 'text', secrets: ['x'] });
    expect(next.stdout.split("\n")[0]).toMatch(/^id\s+name/);
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
