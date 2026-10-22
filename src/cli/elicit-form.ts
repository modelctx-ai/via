// The fields of a form-mode question and the checking of what the person types (ADR 0018). Pure: no
// terminal here, so every rule is a unit test. The schema is the server's and untrusted: what it
// says only decides what is asked and how the answer is checked, and a field of a kind via cannot
// ask makes the whole question unanswerable (it is declined rather than half asked).
import type { ElicitSchema, ElicitValue } from '../client/elicit';

export type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'choice' | 'choices';

export interface Choice {
  value: string;
  /** The server's display name; equal to `value` when it gave none. */
  title: string;
}

export interface Field {
  name: string;
  /** What the person sees first: the server's title, else the name. */
  label: string;
  description?: string;
  kind: FieldKind;
  required: boolean;
  default?: ElicitValue;
  choices?: Choice[];
  /** The raw property schema, for the limits (`minLength`, `maximum`, `format`, …). */
  schema: Record<string, unknown>;
}

/** Most fields one question may have: a form of more than this is not something to answer on a terminal. */
export const MAX_FIELDS = 50;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The options of an enum property in any of the protocol's spellings, or undefined when it is not an enum. */
function choicesOf(schema: Record<string, unknown>): Choice[] | undefined {
  const titled = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(titled)) {
    const out: Choice[] = [];
    for (const entry of titled) {
      if (!isObject(entry) || typeof entry.const !== 'string') return undefined;
      out.push({ value: entry.const, title: typeof entry.title === 'string' ? entry.title : entry.const });
    }
    return out.length > 0 ? out : undefined;
  }
  if (Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === 'string') && schema.enum.length > 0) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return (schema.enum as string[]).map((value, i) => ({ value, title: typeof names[i] === 'string' ? (names[i] as string) : value }));
  }
  return undefined;
}

/** The fields of `schema` in the order the server listed them, or why they cannot be asked. */
export function describeFields(schema: ElicitSchema): { fields: Field[] } | { unsupported: string } {
  const names = Object.keys(schema.properties);
  if (names.length > MAX_FIELDS) return { unsupported: `it has ${names.length} fields` };
  const required = new Set(schema.required ?? []);
  const fields: Field[] = [];
  for (const name of names) {
    const property = schema.properties[name];
    if (!isObject(property)) return { unsupported: `field ${name} is not an object` };
    const base = {
      name,
      label: typeof property.title === 'string' && property.title !== '' ? property.title : name,
      required: required.has(name),
      schema: property,
      ...(typeof property.description === 'string' && property.description !== '' ? { description: property.description } : {}),
    };
    const field = describeOne(base, property);
    if (!field) return { unsupported: `field ${name} has a type that cannot be asked for` };
    fields.push(field);
  }
  return { fields };
}

function describeOne(base: Omit<Field, 'kind'>, property: Record<string, unknown>): Field | undefined {
  const withDefault = (kind: FieldKind, defaultValue: unknown, ok: (value: unknown) => value is ElicitValue, choices?: Choice[]): Field => ({
    ...base,
    kind,
    ...(ok(defaultValue) ? { default: defaultValue } : {}),
    ...(choices ? { choices } : {}),
  });
  switch (property.type) {
    case 'string': {
      const choices = choicesOf(property);
      if (choices) return withDefault('choice', property.default, (v): v is string => typeof v === 'string' && choices.some((c) => c.value === v), choices);
      return withDefault('string', property.default, (v): v is string => typeof v === 'string');
    }
    case 'number':
      return withDefault('number', property.default, (v): v is number => isNumber(v));
    case 'integer':
      return withDefault('integer', property.default, (v): v is number => isNumber(v) && Number.isInteger(v));
    case 'boolean':
      return withDefault('boolean', property.default, (v): v is boolean => typeof v === 'boolean');
    case 'array': {
      const items = isObject(property.items) ? property.items : undefined;
      const choices = items ? choicesOf(items) : undefined;
      if (!choices) return undefined;
      return withDefault('choices', property.default, (v): v is string[] => Array.isArray(v) && v.every((e) => typeof e === 'string' && choices.some((c) => c.value === e)), choices);
    }
    default:
      return undefined;
  }
}

/** `a to b`, `at least a`, `at most b` for the numeric limits of a field; empty when it has none. */
function range(low: unknown, high: unknown, unit = ''): string {
  if (isNumber(low) && isNumber(high)) return `${low} to ${high}${unit}`;
  if (isNumber(low)) return `at least ${low}${unit}`;
  if (isNumber(high)) return `at most ${high}${unit}`;
  return '';
}

/** What kind of answer a field takes, for the prompt: `integer, 1 to 10`, `text, 2 to 12 characters`, `yes or no`. */
export function hintOf(field: Field): string {
  const s = field.schema;
  switch (field.kind) {
    case 'string': {
      const parts = ['text'];
      if (typeof s.format === 'string') parts[0] = s.format === 'date-time' ? 'date and time' : s.format;
      const length = range(s.minLength, s.maxLength, ' characters');
      if (length) parts.push(length);
      return parts.join(', ');
    }
    case 'number':
    case 'integer': {
      const limits = range(s.minimum, s.maximum);
      return limits ? `${field.kind}, ${limits}` : field.kind;
    }
    case 'boolean':
      return 'yes or no';
    case 'choice':
      return 'one of the choices';
    case 'choices': {
      const count = range(s.minItems, s.maxItems, ' choices');
      return count ? `any of the choices, ${count}` : 'any of the choices';
    }
  }
}

/** A default as the prompt shows it (`[3]`, `[green]`, `[yes]`), or undefined when there is none. */
export function defaultLabel(field: Field): string | undefined {
  const value = field.default;
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

export type Read = { ok: true; value: ElicitValue | undefined } | { ok: false; error: string };

const YES = new Set(['y', 'yes', 'true', '1']);
const NO = new Set(['n', 'no', 'false', '0']);

/**
 * What the person typed for `field`. Empty input is the default, else nothing for an optional field,
 * and an error for a required one. A value that breaks the field's limits is an error that says which.
 */
export function readValue(field: Field, input: string): Read {
  const text = input.trim();
  if (text === '') {
    if (field.default !== undefined) return { ok: true, value: field.default };
    if (!field.required) return { ok: true, value: undefined };
    return { ok: false, error: 'this one is required' };
  }
  switch (field.kind) {
    case 'string':
      return readString(field, text);
    case 'number':
    case 'integer':
      return readNumber(field, text);
    case 'boolean': {
      const word = text.toLowerCase();
      if (YES.has(word)) return { ok: true, value: true };
      if (NO.has(word)) return { ok: true, value: false };
      return { ok: false, error: 'answer yes or no' };
    }
    case 'choice': {
      const found = pick(field.choices ?? [], text);
      return found ? { ok: true, value: found.value } : { ok: false, error: `not one of the choices (${(field.choices ?? []).length} offered)` };
    }
    case 'choices': {
      const picked: string[] = [];
      for (const word of text.split(',').map((w) => w.trim()).filter((w) => w !== '')) {
        const found = pick(field.choices ?? [], word);
        if (!found) return { ok: false, error: `${word.slice(0, 40)} is not one of the choices` };
        if (!picked.includes(found.value)) picked.push(found.value);
      }
      const { minItems, maxItems } = field.schema;
      if (isNumber(minItems) && picked.length < minItems) return { ok: false, error: `choose at least ${minItems}` };
      if (isNumber(maxItems) && picked.length > maxItems) return { ok: false, error: `choose at most ${maxItems}` };
      return { ok: true, value: picked };
    }
  }
}

/** A choice named by its number in the list, its value, or its title (case does not matter for the title). */
function pick(choices: readonly Choice[], word: string): Choice | undefined {
  if (/^\d+$/.test(word)) {
    const byNumber = choices[Number(word) - 1];
    if (byNumber) return byNumber;
  }
  return choices.find((c) => c.value === word) ?? choices.find((c) => c.title.toLowerCase() === word.toLowerCase());
}

function readString(field: Field, text: string): Read {
  const { minLength, maxLength, format } = field.schema;
  const length = [...text].length;
  if (isNumber(minLength) && length < minLength) return { ok: false, error: `at least ${minLength} characters` };
  if (isNumber(maxLength) && length > maxLength) return { ok: false, error: `at most ${maxLength} characters` };
  if (typeof format === 'string') {
    const wrong = checkFormat(format, text);
    if (wrong) return { ok: false, error: wrong };
  }
  return { ok: true, value: text };
}

/** The formats of the protocol (`email`, `uri`, `date`, `date-time`); any other is not checked. */
function checkFormat(format: string, text: string): string | undefined {
  switch (format) {
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? undefined : 'not an email address';
    case 'uri':
      try {
        return new URL(text).protocol === '' ? 'not a URI' : undefined;
      } catch {
        return 'not a URI';
      }
    case 'date': {
      const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(text);
      if (!m) return 'use YYYY-MM-DD';
      const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      return date.getUTCFullYear() === Number(m[1]) && date.getUTCMonth() === Number(m[2]) - 1 && date.getUTCDate() === Number(m[3]) ? undefined : 'not a calendar date';
    }
    case 'date-time':
      return /^\d{4}-\d\d-\d\d[Tt ]\d\d:\d\d/.test(text) && !Number.isNaN(Date.parse(text)) ? undefined : 'use YYYY-MM-DDTHH:MM:SSZ';
    default:
      return undefined;
  }
}

function readNumber(field: Field, text: string): Read {
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, error: `not a number` };
  if (field.kind === 'integer' && !Number.isInteger(value)) return { ok: false, error: 'a whole number, please' };
  const { minimum, maximum } = field.schema;
  if (isNumber(minimum) && value < minimum) return { ok: false, error: `at least ${minimum}` };
  if (isNumber(maximum) && value > maximum) return { ok: false, error: `at most ${maximum}` };
  return { ok: true, value };
}
