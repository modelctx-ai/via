import { visibleText } from '../render/shell';
import { displayWidth } from '../render/width';
import type { JsonSchema, ParamInfo } from './types';
import { kebab } from './tokenize';

/** Maximum parameters shown in a one-line signature; required ones are never cut. */
export const SIGNATURE_MAX_PARAMS = 6;

/** A typed signature wider than this many columns falls back to the plain one (discovery.md, "浏览视图"). */
export const TYPED_SIGNATURE_MAX_WIDTH = 60;
/** Allowed values written into a signature as `a|b|c` only when they fit this many characters (the same limit as the `usage:` line). */
const ENUM_INLINE_MAX = 60;
const TYPE_LABELS: Readonly<Record<string, string>> = { string: 'str', number: 'num', integer: 'num', boolean: 'bool', object: 'json', array: 'json' };

/** The short labels of JSON Schema types (`str`, `num`, `bool`, `json`), each once, in order. Shared with the `-h` text (args/help.ts). */
export function typeLabels(types: Iterable<string>): string[] {
  return [...new Set([...types].map((t) => TYPE_LABELS[t]).filter((x): x is string => !!x))];
}

/** The label of array items whose types are all scalar (`str`, `(str|num)`); undefined when any is an object, an array or unknown. */
export function scalarLabel(types: Iterable<string>): string | undefined {
  const labels: string[] = [];
  for (const t of types) {
    if (t === 'null') continue;
    const label = TYPE_LABELS[t];
    if (label === undefined || label === 'json') return undefined;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.length === 0 ? undefined : labels.length === 1 ? labels[0] : `(${labels.join('|')})`;
}
const REF_DEPTH = 8;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Follow a local `$ref` (`#/$defs/x`); anything else (external, unresolvable) stays as it is, without the `$ref`. */
function deref(root: JsonSchema, schema: unknown, depth = 0): Json {
  if (!isObject(schema)) return {};
  const ref = schema.$ref;
  if (typeof ref !== 'string') return schema;
  const { $ref: _ref, ...rest } = schema;
  if (depth > REF_DEPTH || !ref.startsWith('#')) return rest;
  let target: unknown = root;
  if (ref !== '#' && ref !== '#/') {
    for (const raw of ref.slice(2).split('/')) {
      let segment = raw;
      try {
        segment = decodeURIComponent(raw);
      } catch {
        // keep the raw segment
      }
      segment = segment.replace(/~1/g, '/').replace(/~0/g, '~');
      target = Array.isArray(target) ? target[Number(segment)] : isObject(target) && Object.hasOwn(target, segment) ? target[segment] : undefined;
    }
  }
  const resolved = deref(root, target, depth + 1);
  return Object.keys(rest).length === 0 ? resolved : { ...resolved, ...rest };
}

const jsType = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);

/** The JSON types a schema allows; `known` is false when it says nothing usable (same reading as the argument parser's). */
function typesOf(root: JsonSchema, schema: unknown, depth = 0): { types: Set<string>; known: boolean } {
  const r = deref(root, schema);
  const types = new Set<string>();
  if (typeof r.type === 'string') types.add(r.type);
  else if (Array.isArray(r.type) && r.type.length > 0) for (const t of r.type) types.add(String(t));
  else if (Array.isArray(r.enum) && r.enum.length > 0) for (const v of r.enum) types.add(jsType(v));
  else if ('const' in r) types.add(jsType(r.const));
  if (types.size > 0) return { types, known: true };
  if (depth < 6) {
    for (const key of ['anyOf', 'oneOf']) {
      const list = r[key];
      if (Array.isArray(list) && list.length > 0) {
        let known = true;
        for (const b of list) {
          const t = typesOf(root, b, depth + 1);
          if (!t.known) known = false;
          for (const x of t.types) types.add(x);
        }
        return known ? { types, known } : { types: new Set(), known: false };
      }
    }
    if (Array.isArray(r.allOf)) {
      for (const m of r.allOf) {
        const t = typesOf(root, m, depth + 1);
        if (t.known) return t;
      }
    }
  }
  if (r.properties || r.required || r.additionalProperties !== undefined || r.patternProperties) return { types: new Set(['object']), known: true };
  if (r.items !== undefined || r.prefixItems !== undefined) return { types: new Set(['array']), known: true };
  return { types: new Set(), known: false };
}

/** Allowed literal values: `enum`, `const`, or an `anyOf`/`oneOf` made only of those. */
function literalsOf(root: JsonSchema, schema: unknown, depth = 0): unknown[] | undefined {
  const r = deref(root, schema);
  if (Array.isArray(r.enum) && r.enum.length > 0) return r.enum;
  if ('const' in r) return [r.const];
  if (depth < 2) {
    for (const key of ['anyOf', 'oneOf']) {
      const list = r[key];
      if (Array.isArray(list) && list.length > 0) {
        const all: unknown[] = [];
        for (const b of list) {
          const l = literalsOf(root, b, depth + 1);
          if (!l) return undefined;
          all.push(...l);
        }
        return all;
      }
    }
  }
  return undefined;
}

/** The schema of the items of an array schema; none for a tuple (`prefixItems`, or an array-form `items`) or an array that does not say. */
function itemsSchemaOf(root: JsonSchema, schema: unknown, depth = 0): unknown {
  const r = deref(root, schema);
  if (Array.isArray(r.prefixItems) || Array.isArray(r.items)) return undefined;
  if (isObject(r.items)) return r.items;
  if (depth < 3) {
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      const list = r[key];
      if (!Array.isArray(list)) continue;
      for (const branch of list) {
        const found = itemsSchemaOf(root, branch, depth + 1);
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
}

/**
 * The element type of a list of scalars, written as the argument parser accepts it (a flag repeated, or a JSON
 * array): `str`, `num`, `bool`, or `(str|num)`. Undefined for a tuple, a list of objects or lists, and a list
 * whose items the schema does not type, which stay `json`.
 */
function scalarItemLabel(root: JsonSchema, schema: unknown): string | undefined {
  const items = itemsSchemaOf(root, schema);
  if (items === undefined) return undefined;
  const { types, known } = typesOf(root, items);
  if (!known) return undefined;
  return scalarLabel(types);
}

/**
 * What a signature says about a parameter besides its name, read the way the `usage:` line reads it
 * (`<str>`, `<num>`, `a|b`): `values` for an enum that fits on a line, else `type` (`num`, `bool`,
 * `json`, `str|num`). A plain string, and a parameter whose type the schema does not say, have neither.
 */
function describeParam(root: JsonSchema, schema: unknown): Pick<ParamInfo, 'type' | 'values'> {
  const literals = literalsOf(root, schema);
  if (literals && literals.every((v) => ['string', 'number', 'boolean'].includes(typeof v))) {
    const joined = literals.map((v) => visibleText(typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)))).join('|');
    if (joined.length <= ENUM_INLINE_MAX) return { values: joined };
  }
  const { types, known } = typesOf(root, schema);
  if (known && types.size > 0 && [...types].every((t) => t === 'boolean')) return { type: 'bool' };
  if (known && [...types].filter((t) => t !== 'null').join() === 'array') {
    const item = scalarItemLabel(root, schema);
    if (item !== undefined) return { type: `${item}[]` };
  }
  const labels = typeLabels(types);
  return labels.length === 0 || (labels.length === 1 && labels[0] === 'str') ? {} : { type: labels.join('|') };
}

/**
 * Top-level parameters of an input schema: required first, then optional, each group in
 * schema `properties` order. Names are kebab-cased unless two parameters would collide
 * after normalisation, or nothing is left of the name (`_`), in which case the original name is kept
 * (arguments.md).
 */
export function extractParams(schema: JsonSchema | undefined): ParamInfo[] {
  const props = schema?.properties ?? {};
  const requiredSet = new Set(schema?.required ?? []);
  const names = [...Object.keys(props), ...[...requiredSet].filter((n) => !(n in props))];

  const kebabs = names.map(kebab);
  const kebabCount = new Map<string, number>();
  for (const k of kebabs) kebabCount.set(k, (kebabCount.get(k) ?? 0) + 1);

  const all = names.map((name, i): ParamInfo => {
    const k = kebabs[i]!;
    // A name with no letter or digit (`_`) has no kebab-case spelling: it is written as it is, like a name that collides.
    return { name, arg: k === '' || (kebabCount.get(k) ?? 0) > 1 ? name : k, required: requiredSet.has(name), ...describeParam(schema ?? {}, props[name]) };
  });
  return [...all.filter((p) => p.required), ...all.filter((p) => !p.required)];
}

/** `method=get|get_comments`, `issue-number:num`, `draft?` (an optional flag), or the bare name. */
function typedName(p: ParamInfo): string {
  if (p.values !== undefined) return `${p.arg}=${p.values}`;
  if (p.type === 'bool') return p.required ? `${p.arg}:bool` : `${p.arg}?`;
  return p.type !== undefined ? `${p.arg}:${p.type}` : p.arg;
}

/**
 * `owner, repo, [state], [labels]` — required first, optional in brackets. With `typed`, the
 * types and allowed values the schema declares go in (`owner, repo, issue-number:num,
 * method=get|get_comments, [draft?]`) unless that makes the signature wider than
 * {@link TYPED_SIGNATURE_MAX_WIDTH} columns, when the plain form is returned. The parameters shown
 * are the same either way.
 */
export function formatSignature(params: readonly ParamInfo[], maxParams = SIGNATURE_MAX_PARAMS, typed = false): string {
  const required = params.filter((p) => p.required);
  const optional = params.filter((p) => !p.required);
  const room = Math.max(0, maxParams - required.length);
  const shown = optional.slice(0, room);
  const tail = shown.length < optional.length ? ['…'] : [];
  const plain = [...required.map((p) => p.arg), ...shown.map((p) => `[${p.arg}]`), ...tail].join(', ');
  if (!typed || ![...required, ...shown].some((p) => p.type !== undefined || p.values !== undefined)) return plain;
  const full = [...required.map(typedName), ...shown.map((p) => `[${typedName(p)}]`), ...tail].join(', ');
  return displayWidth(full) <= TYPED_SIGNATURE_MAX_WIDTH ? full : plain;
}

/** The complete parameter lists of a tool, by their command-line names (`-o json`; not cut at {@link SIGNATURE_MAX_PARAMS}). */
export function signatureLists(params: readonly ParamInfo[]): { required: string[]; optional: string[] } {
  return { required: params.filter((p) => p.required).map((p) => p.arg), optional: params.filter((p) => !p.required).map((p) => p.arg) };
}

/** First non-empty line of a description, whitespace collapsed, cut to `max` characters. */
export function shortDescription(description: string, max = 60): string {
  const line =
    description
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const chars = Array.from(line.replace(/\s+/g, ' '));
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}
