// The call example at the end of `-h` (arguments.md, "帮助"): one command line that can be pasted
// as it is, built from the input schema. It shows the shape of every kind of argument the tool
// takes, and stays short because it goes into an agent's context: required parameters, then
// optional ones up to three parameters in all.
import { extractParams } from '../../catalog/signature';
import type { CatalogTool, JsonSchema, McpTool } from '../../catalog/types';
import { shellQuote, shellWords } from '../../render/shell';
import { type Pos, SchemaModel } from './schema';
import type { ToolArgsContext } from './types';

/** Parameters shown, required ones first; a tool with more required parameters shows them all. */
const MAX_PARAMS = 3;
/** An optional parameter that would take the line past this many characters is left out. */
const LINE_SOFT_MAX = 200;
/** A call whose required parameters alone take more than this is not shown: it would not help. */
const LINE_HARD_MAX = 400;
/** Nesting followed when writing a value; deeper levels are written as empty containers. */
const MAX_DEPTH = 4;
/** Nested objects written as `--a.b.c value` before the rest is JSON. */
const MAX_DOT_DEPTH = 3;
/** A value taken from the schema (`examples`, `default`) is not used when its JSON is longer. */
const HINT_MAX = 60;
const GENERIC = 'text';
const EMPTY_CONTAINER = /^['"](\{\}|\[\])['"]$/;

/** `format` values with a value that validates; the rest get a plain string. */
const FORMATS: Readonly<Record<string, string>> = {
  'date-time': '2026-01-15T09:00:00Z',
  date: '2026-01-15',
  time: '09:00:00',
  email: 'user@example.com',
  uri: 'https://example.com',
  url: 'https://example.com',
  hostname: 'example.com',
  ipv4: '192.0.2.1',
};

const TYPE_ORDER = ['string', 'integer', 'number', 'boolean', 'array', 'object'];

type Json = string | number | boolean | Json[] | { [key: string]: Json };

function jsonText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Whether a value taken from the schema can be written in a command: it has a safe spelling, a
 * string does not start with `@` (read as a file) or equal `-` (read as stdin).
 */
function usable(value: unknown, hint: boolean): boolean {
  if (value === null || value === undefined) return false;
  const text = jsonText(value);
  if (hint && text.length > HINT_MAX) return false;
  if (typeof value === 'string' && (value.startsWith('@') || value === '-')) return false;
  return shellQuote(text) !== undefined;
}

class Builder {
  constructor(
    private readonly model: SchemaModel,
    /** Use `examples` and `default` of the schema; off for the second try when those cannot be written. */
    private readonly hints: boolean,
  ) {}

  /** The position with its first non-null `anyOf`/`oneOf` branch chosen (nullable, optional, variants). */
  private pick(pos: Pos, depth = 0): Pos {
    if (depth > 3) return pos;
    const branches = this.model.branches(pos);
    if (branches.length === 0) return pos;
    const option = branches[0]!.options.find((o) => !this.nullOnly(o)) ?? branches[0]!.options[0] ?? [];
    // What is left of the schemas around the branches; an empty one would make the type unknown.
    const base = this.model
      .expandPos(pos)
      .map((s) => {
        const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = s;
        return rest as JsonSchema;
      })
      .filter((s) => Object.keys(s).length > 0);
    return this.pick([...base, ...option], depth + 1);
  }

  private nullOnly(option: Pos): boolean {
    const { types, known } = this.model.typeInfoPos(option);
    return known && types.size === 1 && types.has('null');
  }

  /** `enum`/`const` (always), then `examples` and `default` (when hints are on): the first one that can be written. */
  private fixed(pos: Pos): { value: Json } | 'unwritable' | undefined {
    for (const s of pos) {
      const literals = this.model.literals(s);
      if (!literals) continue;
      const hit = literals.find((v) => usable(v, false));
      return hit === undefined ? 'unwritable' : { value: hit as Json };
    }
    // A flag is more telling than its negation: the default of a boolean is not an example.
    if (!this.hints || this.types(pos)[0] === 'boolean') return undefined;
    for (const s of this.model.expandPos(pos)) {
      const examples = Array.isArray(s.examples) ? (s.examples as unknown[]) : 'example' in s ? [s.example] : [];
      const hit = examples.find((v) => usable(v, true)) ?? (usable(s.default, true) ? s.default : undefined);
      if (hit !== undefined) return { value: hit as Json };
    }
    return undefined;
  }

  private types(pos: Pos): string[] {
    const { types } = this.model.typeInfoPos(pos);
    return TYPE_ORDER.filter((t) => types.has(t));
  }

  private first<T>(pos: Pos, read: (s: JsonSchema) => T | undefined): T | undefined {
    for (const s of this.model.expandPos(pos)) {
      const value = read(s);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  /** A JSON value that satisfies the schema at `pos` as far as the example needs; undefined when none can be written. */
  value(position: Pos, depth: number): Json | undefined {
    const pos = this.pick(position);
    const fixed = this.fixed(pos);
    if (fixed === 'unwritable') return undefined;
    if (fixed) return fixed.value;
    switch (this.types(pos)[0]) {
      case 'string': {
        const format = this.first(pos, (s) => (typeof s.format === 'string' ? s.format : undefined));
        return (format !== undefined ? FORMATS[format] : undefined) ?? GENERIC;
      }
      case 'integer':
      case 'number': {
        const min = this.first(pos, (s) => (typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1 : undefined));
        const max = this.first(pos, (s) => (typeof s.maximum === 'number' ? s.maximum : undefined));
        const v = min ?? 1;
        return max !== undefined && v > max ? max : v;
      }
      case 'boolean':
        return true;
      case 'array': {
        // Stops a recursive schema early: an empty list is valid where an object would need more levels.
        if (depth >= MAX_DEPTH - 1) return [];
        const tuple = this.first(pos, (s) => (Array.isArray(s.prefixItems) ? s.prefixItems.length : Array.isArray(s.items) ? s.items.length : undefined));
        if (tuple !== undefined) {
          const out: Json[] = [];
          for (let i = 0; i < Math.min(tuple, 4); i++) out.push(this.value(this.model.items(pos, i), depth + 1) ?? GENERIC);
          return out;
        }
        const items = this.model.items(pos);
        const item = items.length > 0 ? this.value(items, depth + 1) : undefined;
        return item === undefined ? [] : [item];
      }
      case 'object': {
        if (depth >= MAX_DEPTH) return {};
        const out: { [key: string]: Json } = {};
        for (const name of this.selected(pos)) out[name] = this.value(this.model.child(pos, name), depth + 1) ?? GENERIC;
        if (Object.keys(out).length === 0) {
          const extra = this.model.child(pos, 'key');
          const item = extra.length > 0 && this.model.propsOf(pos).size === 0 ? this.value(extra, depth + 1) : undefined;
          if (item !== undefined) out.key = item;
        }
        return out;
      }
      default:
        return GENERIC;
    }
  }

  /** The properties an object example fills in: the required ones, else the first declared one. */
  private selected(pos: Pos): string[] {
    const required = this.model.requiredOf(pos);
    if (required.length > 0) return required;
    const first = [...this.model.propsOf(pos).keys()][0];
    return first === undefined ? [] : [first];
  }

  /**
   * The command-line words that give the parameter at `path` a value, each already quoted: dot paths
   * for an object with declared fields, a repeated flag for a list of scalars, a flag alone or
   * negated for a boolean, JSON for the rest. Undefined when some part has no safe spelling.
   */
  words(path: string[], position: Pos, depth: number): string[] | undefined {
    const pos = this.pick(position);
    const flag = this.model.displayArg(path);
    const fixed = this.fixed(pos);
    if (fixed === undefined && depth < MAX_DOT_DEPTH && this.types(pos)[0] === 'object' && this.model.propsOf(pos).size > 0) {
      const out: string[] = [];
      const names = this.selected(pos);
      if (names.length === 0) return this.single(flag, {});
      for (const name of names) {
        const sub = this.words([...path, name], this.model.child(pos, name), depth + 1);
        if (!sub) return undefined;
        out.push(...sub);
      }
      return out;
    }
    const value = this.value(pos, path.length);
    if (value === undefined) return undefined;
    if (typeof value === 'boolean') {
      if (value) return this.single(flag);
      return path.length === 1 ? this.single(`--no-${flag.slice(2)}`) : this.single(`${flag}=false`);
    }
    const tuple = this.first(pos, (s) => (Array.isArray(s.prefixItems) || Array.isArray(s.items) ? true : undefined));
    if (Array.isArray(value) && !tuple && value.length > 0 && value.every((v) => typeof v !== 'object')) {
      const out: string[] = [];
      for (const item of value) {
        const w = this.single(flag, item);
        if (!w) return undefined;
        out.push(...w);
      }
      return out;
    }
    return this.single(flag, value);
  }

  /** `--flag`, `--flag value` or `--flag=value` (a value that starts with `-` would be read as an option). */
  private single(flag: string, value?: Json): string[] | undefined {
    const name = shellQuote(flag);
    if (name === undefined) return undefined;
    if (value === undefined) return [name];
    const text = jsonText(value);
    if (text.startsWith('-')) {
      const joined = shellQuote(`${flag}=${text}`);
      return joined === undefined ? undefined : [joined];
    }
    const token = shellQuote(text);
    return token === undefined ? undefined : [name, token];
  }
}

/**
 * `example: via <tool> --a x --b.c 1`, or undefined when the tool takes no arguments, a required
 * parameter has no safe spelling, or the call would not be short.
 */
export function formatCallExample(tool: McpTool, ctx: ToolArgsContext): string | undefined {
  const model = new SchemaModel(tool.inputSchema ?? {});
  const params = extractParams(model.resolve(model.root));
  if (params.length === 0) return undefined;
  const head = shellWords(ctx.refWords ?? ctx.ref);
  if (head.includes('<')) return undefined;
  const props = model.propsOf([model.root]);
  const withHints = new Builder(model, true);
  const without = new Builder(model, false);

  let line = `example: via ${head}`;
  let shown = 0;
  for (const param of params) {
    if (!param.required && shown >= MAX_PARAMS) break;
    const pos = props.get(param.name) ?? [];
    const words = withHints.words([param.name], pos, 1) ?? without.words([param.name], pos, 1);
    if (!words) {
      if (param.required) return undefined;
      continue;
    }
    const next = `${line} ${words.join(' ')}`;
    // An optional parameter is shown to teach its shape: an empty container does not, and a long one costs too much.
    if (!param.required && (next.length > LINE_SOFT_MAX || words.some((w) => EMPTY_CONTAINER.test(w)))) continue;
    line = next;
    shown += 1;
  }
  return shown === 0 || line.length > LINE_HARD_MAX ? undefined : line;
}

/**
 * The example of `formatCallExample` without its `example: via <ref> ` head, for the prebuilt
 * catalog (`via find` shows it under each result). The head is the same words `-h` writes, so
 * the two lines are one: `example: via ${shellWords(tool.ref)} ${callExampleArgs(tool)}`.
 */
export function callExampleArgs(tool: CatalogTool): string | undefined {
  try {
    const line = formatCallExample(tool.def, { provider: tool.provider, ref: tool.ref, rawName: tool.rawName, readOnly: tool.readOnly, destructive: tool.destructive });
    const head = `example: via ${shellWords(tool.ref)} `;
    return line?.startsWith(head) ? line.slice(head.length) : undefined;
  } catch {
    return undefined;
  }
}
