// The fields of a form-mode question and what the person may answer (ADR 0018): pure, no terminal.
import { describe, expect, it } from 'vitest';
import { parseAnswer, parseQuestion, urlElicitationsOf } from '../../src/client/elicit';
import { defaultLabel, describeFields, hintOf, MAX_FIELDS, readValue, type Field } from '../../src/cli/elicit-form';

function fields(properties: Record<string, Record<string, unknown>>, required: string[] = []): Field[] {
  const described = describeFields({ type: 'object', properties, required });
  if ('unsupported' in described) throw new Error(described.unsupported);
  return described.fields;
}

const one = (property: Record<string, unknown>, required = false): Field => fields({ f: property }, required ? ['f'] : [])[0]!;

describe('describeFields', () => {
  it('reads every kind the protocol has, in the order listed', () => {
    const list = fields({
      s: { type: 'string', title: 'S', default: 'x' },
      n: { type: 'number' },
      i: { type: 'integer', default: 2 },
      b: { type: 'boolean', default: false },
      e: { type: 'string', enum: ['a', 'b'], enumNames: ['A', 'B'], default: 'b' },
      t: { type: 'string', oneOf: [{ const: 'x', title: 'X' }, { const: 'y', title: 'Y' }] },
      m: { type: 'array', items: { type: 'string', enum: ['p', 'q'] }, default: ['p'] },
      u: { type: 'array', items: { anyOf: [{ const: 'p', title: 'P' }] } },
    });
    expect(list.map((f) => [f.name, f.kind])).toEqual([['s', 'string'], ['n', 'number'], ['i', 'integer'], ['b', 'boolean'], ['e', 'choice'], ['t', 'choice'], ['m', 'choices'], ['u', 'choices']]);
    expect(list.map((f) => f.label)).toEqual(['S', 'n', 'i', 'b', 'e', 't', 'm', 'u']);
    expect(list[4]!.choices).toEqual([{ value: 'a', title: 'A' }, { value: 'b', title: 'B' }]);
    expect(list[5]!.choices).toEqual([{ value: 'x', title: 'X' }, { value: 'y', title: 'Y' }]);
  });

  it('keeps a default only when it fits the field', () => {
    expect(one({ type: 'integer', default: 1.5 }).default).toBeUndefined();
    expect(one({ type: 'string', enum: ['a'], default: 'z' }).default).toBeUndefined();
    expect(one({ type: 'array', items: { type: 'string', enum: ['a'] }, default: ['a', 'z'] }).default).toBeUndefined();
    expect(one({ type: 'boolean', default: 'yes' }).default).toBeUndefined();
  });

  it('refuses a question it cannot ask whole', () => {
    expect(describeFields({ type: 'object', properties: { o: { type: 'object' } } })).toEqual({ unsupported: 'field o has a type that cannot be asked for' });
    expect(describeFields({ type: 'object', properties: { a: { type: 'array', items: { type: 'object' } } } })).toMatchObject({ unsupported: expect.stringContaining('field a') });
    expect(describeFields({ type: 'object', properties: { n: 3 as never } })).toEqual({ unsupported: 'field n is not an object' });
    const many = Object.fromEntries(Array.from({ length: MAX_FIELDS + 1 }, (_, i) => [`f${i}`, { type: 'string' }]));
    expect(describeFields({ type: 'object', properties: many })).toEqual({ unsupported: `it has ${MAX_FIELDS + 1} fields` });
  });
});

describe('what the prompt says', () => {
  it('names the kind and the limits', () => {
    expect(hintOf(one({ type: 'string' }))).toBe('text');
    expect(hintOf(one({ type: 'string', minLength: 2, maxLength: 5 }))).toBe('text, 2 to 5 characters');
    expect(hintOf(one({ type: 'string', format: 'date-time' }))).toBe('date and time');
    expect(hintOf(one({ type: 'integer', minimum: 1 }))).toBe('integer, at least 1');
    expect(hintOf(one({ type: 'number', maximum: 9 }))).toBe('number, at most 9');
    expect(hintOf(one({ type: 'boolean' }))).toBe('yes or no');
    expect(hintOf(one({ type: 'array', items: { type: 'string', enum: ['a'] }, minItems: 1 }))).toBe('any of the choices, at least 1 choices');
  });

  it('shows defaults the way they are typed', () => {
    expect(defaultLabel(one({ type: 'boolean', default: true }))).toBe('yes');
    expect(defaultLabel(one({ type: 'integer', default: 3 }))).toBe('3');
    expect(defaultLabel(one({ type: 'array', items: { type: 'string', enum: ['a', 'b'] }, default: ['a', 'b'] }))).toBe('a, b');
    expect(defaultLabel(one({ type: 'string' }))).toBeUndefined();
  });
});

describe('readValue', () => {
  it('an empty line is the default, nothing for an optional field, an error for a required one', () => {
    expect(readValue(one({ type: 'integer', default: 3 }, true), '  ')).toEqual({ ok: true, value: 3 });
    expect(readValue(one({ type: 'string' }), '')).toEqual({ ok: true, value: undefined });
    expect(readValue(one({ type: 'string' }, true), '')).toEqual({ ok: false, error: 'this one is required' });
  });

  it('checks strings against length and format', () => {
    const name = one({ type: 'string', minLength: 2, maxLength: 4 });
    expect(readValue(name, 'a')).toEqual({ ok: false, error: 'at least 2 characters' });
    expect(readValue(name, 'abcde')).toEqual({ ok: false, error: 'at most 4 characters' });
    expect(readValue(name, '日本語')).toEqual({ ok: true, value: '日本語' });
    expect(readValue(one({ type: 'string', format: 'email' }), 'a@b.co')).toEqual({ ok: true, value: 'a@b.co' });
    expect(readValue(one({ type: 'string', format: 'email' }), 'nope')).toEqual({ ok: false, error: 'not an email address' });
    expect(readValue(one({ type: 'string', format: 'uri' }), 'nope')).toEqual({ ok: false, error: 'not a URI' });
    expect(readValue(one({ type: 'string', format: 'uri' }), 'https://x.test')).toEqual({ ok: true, value: 'https://x.test' });
    expect(readValue(one({ type: 'string', format: 'date' }), '2026-02-30')).toEqual({ ok: false, error: 'not a calendar date' });
    expect(readValue(one({ type: 'string', format: 'date' }), '2026-02-28')).toEqual({ ok: true, value: '2026-02-28' });
    expect(readValue(one({ type: 'string', format: 'date-time' }), '2026-02-28T10:00:00Z')).toEqual({ ok: true, value: '2026-02-28T10:00:00Z' });
    expect(readValue(one({ type: 'string', format: 'date-time' }), 'tomorrow')).toMatchObject({ ok: false });
    expect(readValue(one({ type: 'string', format: 'something-new' }), 'x')).toEqual({ ok: true, value: 'x' });
  });

  it('checks numbers', () => {
    const count = one({ type: 'integer', minimum: 1, maximum: 10 });
    expect(readValue(count, '5')).toEqual({ ok: true, value: 5 });
    expect(readValue(count, '5.5')).toEqual({ ok: false, error: 'a whole number, please' });
    expect(readValue(count, '0')).toEqual({ ok: false, error: 'at least 1' });
    expect(readValue(count, '11')).toEqual({ ok: false, error: 'at most 10' });
    expect(readValue(count, 'ten')).toEqual({ ok: false, error: 'not a number' });
    expect(readValue(count, 'Infinity')).toEqual({ ok: false, error: 'not a number' });
    expect(readValue(one({ type: 'number' }), '0.25')).toEqual({ ok: true, value: 0.25 });
  });

  it('reads yes and no', () => {
    const flag = one({ type: 'boolean' });
    for (const word of ['y', 'YES', 'true', '1']) expect(readValue(flag, word)).toEqual({ ok: true, value: true });
    for (const word of ['n', 'No', 'false', '0']) expect(readValue(flag, word)).toEqual({ ok: true, value: false });
    expect(readValue(flag, 'maybe')).toEqual({ ok: false, error: 'answer yes or no' });
  });

  it('picks a choice by number, value or title', () => {
    const color = one({ type: 'string', enum: ['red', 'green'], enumNames: ['Red', 'Verde'] });
    expect(readValue(color, '2')).toEqual({ ok: true, value: 'green' });
    expect(readValue(color, 'red')).toEqual({ ok: true, value: 'red' });
    expect(readValue(color, 'verde')).toEqual({ ok: true, value: 'green' });
    expect(readValue(color, '3')).toMatchObject({ ok: false });
    expect(readValue(color, 'blue')).toMatchObject({ ok: false });
  });

  it('reads several choices and checks how many', () => {
    const tags = one({ type: 'array', items: { type: 'string', enum: ['a', 'b', 'c'] }, minItems: 1, maxItems: 2 });
    expect(readValue(tags, 'a, 3')).toEqual({ ok: true, value: ['a', 'c'] });
    expect(readValue(tags, '1,1')).toEqual({ ok: true, value: ['a'] });
    expect(readValue(tags, 'a,b,c')).toEqual({ ok: false, error: 'choose at most 2' });
    expect(readValue(tags, 'z')).toEqual({ ok: false, error: 'z is not one of the choices' });
    expect(readValue(tags, ',')).toEqual({ ok: false, error: 'choose at least 1' });
  });
});

describe('answers and questions off the wire', () => {
  it('accepts exactly the shapes the protocol allows', () => {
    expect(parseAnswer({ action: 'accept', content: { a: 'x', b: 1, c: true, d: ['p'] } })).toEqual({ action: 'accept', content: { a: 'x', b: 1, c: true, d: ['p'] } });
    expect(parseAnswer({ action: 'accept' })).toEqual({ action: 'accept' });
    expect(parseAnswer({ action: 'decline', content: { a: 1 } })).toEqual({ action: 'decline' });
    expect(parseAnswer({ action: 'accept', content: { a: { b: 1 } } })).toEqual({ action: 'cancel' });
    expect(parseAnswer({ action: 'accept', content: { a: [1] } })).toEqual({ action: 'cancel' });
    expect(parseAnswer({ action: 'accept', content: { a: Number.NaN } })).toEqual({ action: 'cancel' });
    expect(parseAnswer({ action: 'accept', content: ['x'] })).toEqual({ action: 'cancel' });
    expect(parseAnswer({ action: 'maybe' })).toEqual({ action: 'cancel' });
    expect(parseAnswer(null)).toEqual({ action: 'cancel' });
    expect(parseAnswer('accept')).toEqual({ action: 'cancel' });
  });

  it('keeps a key called __proto__ an ordinary key', () => {
    const answer = parseAnswer(JSON.parse('{"action":"accept","content":{"__proto__":"x"}}'));
    expect(answer.action === 'accept' && Object.keys(answer.content ?? {})).toEqual(['__proto__']);
    expect(Object.getPrototypeOf((answer as { content: object }).content)).toBe(Object.prototype);
  });

  it('reads the protocol parameters of both modes', () => {
    expect(parseQuestion({ message: 'm', requestedSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a', 1] } }, 'p')).toEqual({
      mode: 'form',
      provider: 'p',
      message: 'm',
      requestedSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
    });
    expect(parseQuestion({ mode: 'url', message: 'm', url: 'https://x.test' }, 'p')).toEqual({ mode: 'url', provider: 'p', message: 'm', url: 'https://x.test' });
    expect(parseQuestion({ mode: 'url', message: 'm' }, 'p')).toBeUndefined();
    expect(parseQuestion({ message: 'm' }, 'p')).toBeUndefined();
    expect(parseQuestion(null, 'p')).toBeUndefined();
  });

  it('reads the pages of URLElicitationRequired', () => {
    const error = { code: -32042, data: { elicitations: [{ mode: 'url', url: 'https://x.test', message: 'go' }, { mode: 'form' }, { mode: 'url', url: 7 }] } };
    expect(urlElicitationsOf(error)).toEqual([{ url: 'https://x.test', message: 'go' }]);
    expect(urlElicitationsOf({ code: -32042, data: {} })).toBeUndefined();
    expect(urlElicitationsOf({ code: -32602 })).toBeUndefined();
    expect(urlElicitationsOf(new Error('x'))).toBeUndefined();
  });
});
