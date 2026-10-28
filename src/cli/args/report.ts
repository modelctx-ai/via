// Turning parse and validation failures into the fixed phrasings of arguments.md ("报错").
import { didYouMean } from '../../catalog/edit-distance';
import { kebab } from '../../catalog/tokenize';
import type { JsonSchema } from '../../catalog/types';
import { scannerOf } from '../../render/redact';
import { visibleText } from '../../render/shell';
import { alignRows, truncateChars } from '../../render/width';
import type { ErrorObject } from '../../schema/validate';
import { isPlainObject, rootFlagName, type SchemaModel } from './schema';
import { type ArgIssue, ToolArgsError } from './types';

/** Longest `(got …)` value shown, in characters. */
export const GOT_MAX = 40;
const ENUM_LIST_MAX = 12;

export type Segment = string | number;

export interface Problem {
  /** Report order: 0 parse-phase, 1 required, 2 invalid value, 3 unknown argument. */
  group: 0 | 1 | 2 | 3;
  arg: string;
  message: string;
  /** Wording for the one-line form (`--repo is required`); defaults to `${arg} ${message}`. */
  single?: string;
  /** The `-o json` detail object (`arg`, `path`, `rule`, …). */
  detail: Record<string, unknown>;
}

export function pointerOf(segments: readonly Segment[]): string {
  return segments.map((s) => `/${String(s).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

export function segmentsOf(args: unknown, instancePath: string): Segment[] {
  if (!instancePath) return [];
  const out: Segment[] = [];
  let cur: unknown = args;
  for (const raw of instancePath.slice(1).split('/')) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) {
      out.push(Number(seg));
      cur = cur[Number(seg)];
    } else {
      out.push(seg);
      cur = isPlainObject(cur) ? cur[seg] : undefined;
    }
  }
  return out;
}

export function valueAt(args: unknown, segments: readonly Segment[]): unknown {
  let cur: unknown = args;
  for (const s of segments) {
    if (Array.isArray(cur)) cur = cur[Number(s)];
    else if (isPlainObject(cur)) cur = cur[String(s)];
    else return undefined;
  }
  return cur;
}

/** A value as shown after `got`: redacted first, then cut to 40 characters. */
export function gotText(value: unknown, redact: (s: string) => string): string {
  if (typeof value === 'string') return JSON.stringify(truncateChars(redact(value), GOT_MAX));
  return truncateChars(redact(JSON.stringify(value) ?? String(value)), GOT_MAX);
}

/** The `got` field of the `-o json` details: same truncation and redaction. */
function gotJson(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === 'string') return truncateChars(redact(value), GOT_MAX);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  return truncateChars(redact(JSON.stringify(value) ?? String(value)), GOT_MAX);
}

const ARTICLES: Record<string, string> = {
  string: 'a string',
  number: 'a number',
  integer: 'an integer',
  boolean: 'a boolean',
  object: 'an object',
  array: 'an array',
  null: 'null',
};

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

function literal(v: unknown): string {
  return typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
}

function enumList(values: readonly unknown[]): string {
  const shown = values.slice(0, ENUM_LIST_MAX).map(literal).join(', ');
  return values.length > ENUM_LIST_MAX ? `${shown}, … (${values.length - ENUM_LIST_MAX} more)` : shown;
}

function suggestLiteral(got: unknown, allowed: readonly unknown[]): string | undefined {
  if (typeof got !== 'string') return undefined;
  const candidates = allowed.filter((v): v is string => typeof v === 'string');
  const folded = candidates.find((c) => c.toLowerCase() === got.toLowerCase() && c !== got);
  if (folded) return folded;
  return didYouMean(got, candidates, 1)[0];
}

function codePoints(s: string): number {
  return Array.from(s).length;
}

/** Fields that tell the branches of an anyOf/oneOf apart ("must provide one of: page_id, …"). */
function branchKeys(model: SchemaModel, branch: JsonSchema[]): string[] {
  const types = model.typeInfoPos(branch);
  if (types.known && !types.types.has('object')) return [...types.types];
  const props = model.propsOf(branch);
  const single = (name: string) => (props.get(name) ?? []).some((s) => model.singleValue(s));
  const required = model.requiredOf(branch).filter((r) => !single(r));
  if (required.length > 0) return [required.join('+')];
  const optional = [...props.keys()].filter((p) => !single(p));
  if (optional.length > 0) return optional;
  const fixed = [...props.keys()];
  return fixed.length > 0 ? fixed : ['(any)'];
}

export function problemsFromAjv(
  model: SchemaModel,
  errors: readonly ErrorObject[],
  args: unknown,
  redact: (s: string) => string,
): Problem[] {
  const alternatives = errors.filter((e) => e.keyword === 'anyOf' || e.keyword === 'oneOf');
  const kept = errors.filter(
    (e) => e.keyword !== 'if' && !alternatives.some((a) => a !== e && e.schemaPath.startsWith(`${a.schemaPath}/`)),
  );
  const out: Problem[] = [];
  const seen = new Set<string>();
  for (const e of kept) {
    const p = problemFromError(model, e, args, redact);
    if (!p) continue;
    const key = `${p.arg}\u0000${p.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function problemFromError(model: SchemaModel, e: ErrorObject, args: unknown, redact: (s: string) => string): Problem | undefined {
  const base = segmentsOf(args, e.instancePath);
  const params = e.params as Record<string, unknown>;
  const data = valueAt(args, base);
  const make = (
    segs: Segment[],
    message: string,
    rule: string,
    extra: Record<string, unknown> = {},
    group: Problem['group'] = 2,
    single?: string,
  ): Problem => {
    const arg = model.displayArg(segs);
    return { group, arg, message, ...(single ? { single } : {}), detail: { arg, path: pointerOf(segs), rule, ...extra } };
  };
  const withGot = (v: unknown) => ` (got ${gotText(v, redact)})`;

  switch (e.keyword) {
    case 'required': {
      const segs = [...base, String(params.missingProperty)];
      return make(segs, 'required', 'required', {}, 1, `${model.displayArg(segs)} is required`);
    }
    case 'dependentRequired':
    case 'dependencies': {
      const segs = [...base, String(params.missingProperty)];
      const dep = model.displayArg([...base, String(params.property)]);
      return make(segs, `required when ${dep} is set`, e.keyword, {}, 1);
    }
    case 'type': {
      const types = String(params.type).split(',');
      const text = types.map((t) => ARTICLES[t] ?? t).join(' or ');
      return make(base, `must be ${text}${withGot(data)}`, 'type', { expected: types, got: gotJson(data, redact) });
    }
    case 'enum':
    case 'const': {
      const allowed = e.keyword === 'enum' ? (params.allowedValues as unknown[]) : [params.allowedValue];
      const hint = suggestLiteral(data, allowed);
      const detail: Record<string, unknown> = { expected: allowed, got: gotJson(data, redact) };
      let tail = withGot(data);
      if (hint !== undefined) {
        detail.suggest = hint;
        tail = ` (got ${gotText(data, redact)}; did you mean ${JSON.stringify(hint)}?)`;
      }
      return make(base, `must be one of: ${enumList(allowed)}${tail}`, e.keyword, detail);
    }
    case 'maximum':
    case 'minimum':
    case 'exclusiveMaximum':
    case 'exclusiveMinimum':
      return make(base, `must be ${String(params.comparison)} ${String(params.limit)}${withGot(data)}`, e.keyword, {
        expected: params.limit,
        got: gotJson(data, redact),
      });
    case 'multipleOf':
      return make(base, `must be a multiple of ${String(params.multipleOf)}${withGot(data)}`, e.keyword, {
        expected: params.multipleOf,
        got: gotJson(data, redact),
      });
    case 'maxLength':
    case 'minLength': {
      const limit = Number(params.limit);
      const len = typeof data === 'string' ? codePoints(data) : 0;
      const bound = e.keyword === 'maxLength' ? 'at most' : 'at least';
      return make(base, `must be ${bound} ${limit} ${plural(limit, 'character')} (got ${len})`, e.keyword, { expected: limit, got: len });
    }
    case 'pattern':
      return make(base, `must match ${String(params.pattern)}${withGot(data)}`, 'pattern', {
        expected: params.pattern,
        got: gotJson(data, redact),
      });
    case 'maxItems':
    case 'minItems': {
      const limit = Number(params.limit);
      const len = Array.isArray(data) ? data.length : 0;
      const bound = e.keyword === 'maxItems' ? 'at most' : 'at least';
      return make(base, `must have ${bound} ${limit} ${plural(limit, 'item')} (got ${len})`, e.keyword, { expected: limit, got: len });
    }
    case 'uniqueItems':
      return make(base, 'must not contain duplicate items', 'uniqueItems');
    case 'maxProperties':
    case 'minProperties': {
      const limit = Number(params.limit);
      const len = isPlainObject(data) ? Object.keys(data).length : 0;
      const bound = e.keyword === 'maxProperties' ? 'at most' : 'at least';
      return make(base, `must have ${bound} ${limit} ${plural(limit, 'property', 'properties')} (got ${len})`, e.keyword, {
        expected: limit,
        got: len,
      });
    }
    case 'additionalProperties':
    case 'unevaluatedProperties': {
      const key = String(params.additionalProperty ?? params.unevaluatedProperty);
      return unknownArgument(model, base, key, e.keyword);
    }
    case 'anyOf':
    case 'oneOf': {
      const owner = model.pointerValue(e.schemaPath);
      const branches = (Array.isArray(owner) ? owner : []).map((b) => model.expand(b));
      const passing = Array.isArray(params.passingSchemas) ? (params.passingSchemas as number[]) : undefined;
      const chosen = passing && passing.length > 1 ? passing.map((i) => branches[i]).filter((b): b is JsonSchema[] => !!b) : branches;
      const keys = [...new Set(chosen.flatMap((b) => branchKeys(model, b)))];
      const scalar = data !== null && typeof data === 'object' ? '' : withGot(data);
      const text = keys.length > 0 ? keys.join(', ') : 'a matching option';
      const verb = passing && passing.length > 1 ? 'must provide only one of' : 'must provide one of';
      return make(base, `${verb}: ${text}${scalar}`, e.keyword, { expected: keys });
    }
    case 'not':
    case 'false schema':
      return make(base, 'is not allowed', e.keyword === 'not' ? 'not' : 'false');
    case 'contains':
    case 'minContains':
      return make(base, 'must contain a matching item', e.keyword);
    case 'propertyNames':
      return make(base, 'has an invalid property name', 'propertyNames');
    default:
      return make(base, `${e.message ?? 'is invalid'}${typeof data === 'object' ? '' : withGot(data)}`, e.keyword);
  }
}

/** `--titel  unknown argument; did you mean --title?` */
export function unknownArgument(model: SchemaModel, parent: Segment[], key: string, rule = 'additionalProperties'): Problem {
  const segs = [...parent, key];
  const arg = model.displayArg(segs);
  const names = model.nameIndex(parentPos(model, parent));
  const candidates = names.names.map((n) => names.show(n));
  const near = didYouMean(kebab(key) || key, candidates, 1)[0];
  const prefix = parent.length === 0 ? '--' : `${model.displayArg(parent)}.`;
  const shown = near === undefined ? undefined : parent.length === 0 ? `--${rootFlagName(near)}` : `${prefix}${near}`;
  const message = `unknown argument${shown ? `; did you mean ${shown}?` : ''}`;
  return {
    group: 3,
    arg,
    message,
    single: `unknown argument ${arg}${shown ? `; did you mean ${shown}?` : ''}`,
    detail: { arg, path: pointerOf(segs), rule, ...(shown ? { suggest: shown } : {}) },
  };
}

function parentPos(model: SchemaModel, parent: Segment[]) {
  let pos = [model.root] as JsonSchema[];
  for (const s of parent) pos = typeof s === 'number' ? model.items(pos, s) : model.child(pos, s);
  return pos;
}

/** Format-mismatch warnings (`--due should be a date-time (got "tomorrow")`). */
export function formatWarnings(model: SchemaModel, errors: readonly ErrorObject[], args: unknown, redact: (s: string) => string): string[] {
  const out: string[] = [];
  for (const e of errors) {
    const segs = segmentsOf(args, e.instancePath);
    const format = String((e.params as Record<string, unknown>).format);
    const article = /^[aeiou]/.test(format) && !/^(uri|url|uuid|ulid|unix)/.test(format) ? 'an' : 'a';
    const text = `${model.displayArg(segs)} should be ${article} ${format} (got ${gotText(valueAt(args, segs), redact)})`;
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

/** Build the error thrown for a failed parse or validation. `ref` is the tool reference already written as shell words. */
export function buildToolArgsError(problems: readonly Problem[], usage: string, ref: string, redact: (s: string) => string): ToolArgsError {
  const ordered = [...problems].sort((a, b) => a.group - b.group);
  const merged: Array<{ arg: string; messages: string[]; single: string }> = [];
  for (const p of ordered) {
    const hit = merged.find((m) => m.arg === p.arg);
    if (hit) hit.messages.push(p.message);
    else merged.push({ arg: p.arg, messages: [p.message], single: p.single ?? `${p.arg} ${p.message}` });
  }
  // The wording is ours and the values it echoes (`got`) are redacted where they are written, so the
  // text is only scanned for long credentials. An argument name is a key: the user may have typed anything.
  // An argument name or a value may hold a line break or a terminal escape: it is shown as visible text.
  const scanRedacted = scannerOf(redact);
  const scan = (s: string): string => visibleText(scanRedacted(s));
  const nameOf = (arg: string): string => (redact as { key?: (k: string) => string }).key?.(arg) ?? arg;
  const issues: ArgIssue[] = merged.map((m) => ({ arg: visibleText(nameOf(m.arg)), message: scan(m.messages.join('; ')) }));
  const multi = merged.length > 1;
  const first = merged[0]!;
  const message = multi
    ? `${merged.length} invalid arguments`
    : scan(nameOf(first.arg) !== first.arg || first.messages.length > 1 ? `${nameOf(first.arg)} ${first.messages.join('; ')}` : first.single);
  const details = ordered.map((p) => {
    const detail = { ...p.detail };
    if (typeof detail.arg === 'string') detail.arg = nameOf(detail.arg);
    if (typeof detail.path === 'string') detail.path = nameOf(detail.path);
    return detail;
  });
  return new ToolArgsError(message, issues, usage, multi ? `via ${ref} -h` : undefined, details);
}

/**
 * Lines that go between the `error:` line and the `next:` line: the per-argument block when there
 * is more than one problem, then the `usage:` block.
 */
export function argsErrorLines(err: ToolArgsError): string[] {
  const lines: string[] = [];
  if (err.issues.length > 1) lines.push(...alignRows(err.issues.map((i) => [`  ${i.arg}`, i.message]), 3));
  if (err.usage) lines.push(...err.usage.split('\n'));
  return lines;
}
