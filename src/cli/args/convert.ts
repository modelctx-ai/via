// Command-line string -> JSON value, driven by the schema (arguments.md, "JSON 输入").
import { parseJson, type JsonResult } from './json';
import { type Pos, SchemaModel } from './schema';

export interface Target {
  pos: Pos;
  types: Set<string>;
  /** False when the schema is loose about the type: the value is JSON if it parses, else a string. */
  known: boolean;
  /** An object type that declares no fields and allows any: treated like a loose value. */
  schemaless: boolean;
}

export type Converted = { ok: true; value: unknown } | { ok: false; failure: Extract<JsonResult, { ok: false }> };

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

export function targetOf(model: SchemaModel, pos: Pos): Target {
  const { types, known } = model.typeInfoPos(pos);
  const schemaless = known && types.has('object') && model.propsOf(pos).size === 0 && model.allowsExtra(pos);
  return { pos, types, known, schemaless };
}

const ok = (value: unknown): Converted => ({ ok: true, value });

/** Convert one scalar-position string. Never guesses beyond what the schema declares. */
export function convertValue(text: string, t: Target): Converted {
  const T = t.types;
  if (!t.known) {
    const r = parseJson(text);
    return ok(r.ok ? r.value : text);
  }
  const c = text.trimStart()[0];
  const looksObject = c === '{' && T.has('object');
  const looksArray = c === '[' && T.has('array');

  if (T.has('string')) {
    // Strings are never reinterpreted, except where the schema also allows an object/array and the
    // value is JSON of that kind.
    if (looksObject || looksArray) {
      const r = parseJson(text);
      if (r.ok && (looksObject ? !Array.isArray(r.value) && typeof r.value === 'object' : Array.isArray(r.value))) return ok(r.value);
    }
    return ok(text);
  }

  if (looksObject || looksArray) {
    const r = parseJson(text);
    if (r.ok) return ok(r.value);
    if (!t.schemaless) return { ok: false, failure: r };
    return ok(text);
  }
  const s = text.trim();
  if ((T.has('number') || T.has('integer')) && NUMBER.test(s)) return ok(Number(s));
  if (T.has('boolean') && (s === 'true' || s === 'false')) return ok(s === 'true');
  if (T.has('null') && s === 'null') return ok(null);
  if (T.has('object') || T.has('array')) {
    if (t.schemaless) {
      const r = parseJson(text);
      return ok(r.ok ? r.value : text);
    }
    if (!(T.has('number') || T.has('integer') || T.has('boolean') || T.has('null'))) {
      const r = parseJson(text);
      return r.ok ? ok(r.value) : { ok: false, failure: r };
    }
  }
  // Leave the string; validation reports the type mismatch (`must be a number (got "abc")`).
  return ok(text);
}

/** Whether a value of this target is given as `--flag` / `--no-flag` without a value. */
export function isBooleanOnly(t: Target): boolean {
  return t.known && t.types.size > 0 && [...t.types].every((x) => x === 'boolean');
}

export function allowsBoolean(t: Target): boolean {
  return !t.known || t.types.has('boolean');
}

/** Array values: repeat the flag for scalar items, or one JSON array. */
export function isArrayTarget(t: Target): boolean {
  return t.known && t.types.has('array') && !t.types.has('string');
}
