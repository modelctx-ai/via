// Read-only view of a tool's input schema: internal $ref resolution, type information,
// declared properties and the name normalisation of arguments.md ("参数名").
import type { JsonSchema } from '../../catalog/types';
import { kebab } from '../../catalog/tokenize';

/** A position in the argument tree: the (resolved) schemas that describe it. Empty = nothing declared. */
export type Pos = JsonSchema[];

export interface TypeInfo {
  types: Set<string>;
  /** False when the schema says nothing usable about the type ("schema 宽松"). */
  known: boolean;
}

/** Global options a tool parameter must be addressed through `--p.<name>` (cli.md). */
export const GLOBAL_OPTION_NAMES: ReadonlySet<string> = new Set(['full', 'all', 'yes', 'dry-run', 'no-validate', 'timeout', 'help', 'schema-snapshot', 'schema-mode']);

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function jsType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

export type NameLookup = { orig: string } | { ambiguous: string[] } | undefined;

/** Declared names at one level, with display spelling and collision handling. */
export class NameIndex {
  readonly names: string[];
  private readonly display = new Map<string, string>();
  private readonly byNorm = new Map<string, string[]>();

  constructor(names: Iterable<string>) {
    this.names = [...new Set(names)];
    for (const n of this.names) {
      const k = kebab(n);
      if (k === '') continue;
      const list = this.byNorm.get(k) ?? [];
      list.push(n);
      this.byNorm.set(k, list);
    }
    for (const n of this.names) {
      const k = kebab(n);
      const clash = k === '' || (this.byNorm.get(k)?.length ?? 0) > 1;
      this.display.set(n, clash ? n : k);
    }
  }

  /** The spelling shown in help and errors; undeclared names are shown as they are. */
  show(name: string): string {
    return this.display.get(name) ?? name;
  }

  has(name: string): boolean {
    return this.display.has(name);
  }

  /** Groups of original names that collapse to the same kebab-case spelling. */
  collisions(): string[][] {
    return [...this.byNorm.values()].filter((l) => l.length > 1);
  }

  lookup(seg: string): NameLookup {
    if (this.display.has(seg)) return { orig: seg };
    const k = kebab(seg);
    if (k === '') return undefined;
    const hits = this.byNorm.get(k);
    if (!hits) return undefined;
    if (hits.length > 1) return { ambiguous: hits };
    return { orig: hits[0]! };
  }
}

const MAX_DEPTH = 12;

export class SchemaModel {
  constructor(readonly root: JsonSchema) {}

  /** Follow internal `$ref`s; external ones and booleans become permissive/empty schemas. */
  resolve(s: unknown, depth = 0): JsonSchema {
    if (s === true || s === undefined || s === null) return {};
    if (s === false) return { not: {} };
    if (typeof s !== 'object' || Array.isArray(s)) return {};
    const schema = s as JsonSchema;
    const ref = schema.$ref;
    if (typeof ref !== 'string') return schema;
    if (depth > MAX_DEPTH || !ref.startsWith('#')) {
      const { $ref: _ref, ...rest } = schema;
      return rest as JsonSchema;
    }
    const target = this.pointer(ref.slice(1));
    const { $ref: _ref, ...rest } = schema;
    const resolved = this.resolve(target, depth + 1);
    return Object.keys(rest).length === 0 ? resolved : ({ ...resolved, ...rest } as JsonSchema);
  }

  /** The value at a ajv `schemaPath` such as `#/$defs/parent/oneOf`. */
  pointerValue(schemaPath: string): unknown {
    return schemaPath.startsWith('#') ? this.pointer(schemaPath.slice(1)) : undefined;
  }

  private pointer(ptr: string): unknown {
    if (ptr === '' || ptr === '/') return this.root;
    if (!ptr.startsWith('/')) return undefined;
    let cur: unknown = this.root;
    for (const raw of ptr.slice(1).split('/')) {
      let seg: string;
      try {
        seg = decodeURIComponent(raw);
      } catch {
        seg = raw;
      }
      seg = seg.replace(/~1/g, '/').replace(/~0/g, '~');
      if (Array.isArray(cur)) cur = cur[Number(seg)];
      else if (isPlainObject(cur)) cur = Object.hasOwn(cur, seg) ? cur[seg] : undefined;
      else return undefined;
    }
    return cur;
  }

  /** The resolved schema plus its `allOf` members, flattened. */
  expand(s: unknown, depth = 0): JsonSchema[] {
    const r = this.resolve(s);
    const out = [r];
    if (depth < 6 && Array.isArray(r.allOf)) for (const m of r.allOf) out.push(...this.expand(m, depth + 1));
    return out;
  }

  expandPos(pos: Pos): JsonSchema[] {
    const out: JsonSchema[] = [];
    for (const s of pos) for (const e of this.expand(s)) if (!out.includes(e)) out.push(e);
    return out;
  }

  /** `anyOf`/`oneOf` branches of a position, each expanded. */
  branches(pos: Pos): Array<{ keyword: 'anyOf' | 'oneOf'; owner: JsonSchema; options: JsonSchema[][] }> {
    const out: Array<{ keyword: 'anyOf' | 'oneOf'; owner: JsonSchema; options: JsonSchema[][] }> = [];
    for (const s of this.expandPos(pos)) {
      for (const keyword of ['anyOf', 'oneOf'] as const) {
        const list = s[keyword];
        if (Array.isArray(list) && list.length > 0) out.push({ keyword, owner: s, options: list.map((b) => this.expand(b)) });
      }
    }
    return out;
  }

  typeInfo(s: unknown, depth = 0): TypeInfo {
    const r = this.resolve(s);
    const types = new Set<string>();
    if (typeof r.type === 'string') types.add(r.type);
    else if (Array.isArray(r.type) && r.type.length > 0) for (const t of r.type) types.add(String(t));
    else if (Array.isArray(r.enum) && r.enum.length > 0) for (const v of r.enum) types.add(jsType(v));
    else if ('const' in r) types.add(jsType(r.const));
    if (types.size > 0) {
      if (types.has('integer') && !types.has('number') && Array.isArray(r.enum)) types.add('number');
      return { types, known: true };
    }
    if (depth < 6) {
      for (const key of ['anyOf', 'oneOf'] as const) {
        const list = r[key];
        if (Array.isArray(list) && list.length > 0) {
          let known = true;
          for (const b of list) {
            const t = this.typeInfo(b, depth + 1);
            if (!t.known) known = false;
            for (const x of t.types) types.add(x);
          }
          return known ? { types, known } : { types: new Set(), known: false };
        }
      }
      if (Array.isArray(r.allOf)) {
        for (const m of r.allOf) {
          const t = this.typeInfo(m, depth + 1);
          if (t.known) return t;
        }
      }
    }
    if (r.properties || r.required || r.additionalProperties !== undefined || r.patternProperties) return { types: new Set(['object']), known: true };
    if (r.items !== undefined || r.prefixItems !== undefined) return { types: new Set(['array']), known: true };
    return { types: new Set(), known: false };
  }

  typeInfoPos(pos: Pos): TypeInfo {
    if (pos.length === 0) return { types: new Set(), known: false };
    const types = new Set<string>();
    let known = true;
    for (const s of pos) {
      const t = this.typeInfo(s);
      if (!t.known) known = false;
      for (const x of t.types) types.add(x);
    }
    return known ? { types, known } : { types: new Set(), known: false };
  }

  /** Declared properties at a position, in schema order (alternatives of anyOf/oneOf included). */
  propsOf(pos: Pos, depth = 0): Map<string, JsonSchema[]> {
    const out = new Map<string, JsonSchema[]>();
    const add = (k: string, s: JsonSchema) => {
      const list = out.get(k);
      if (list) list.push(s);
      else out.set(k, [s]);
    };
    for (const s of this.expandPos(pos)) {
      if (isPlainObject(s.properties)) for (const [k, v] of Object.entries(s.properties)) add(k, v as JsonSchema);
      if (depth < 3) {
        for (const keyword of ['anyOf', 'oneOf'] as const) {
          const list = s[keyword];
          if (!Array.isArray(list)) continue;
          for (const b of list) for (const [k, ss] of this.propsOf([b as JsonSchema], depth + 1)) for (const x of ss) add(k, x);
        }
      }
    }
    return out;
  }

  requiredOf(pos: Pos): string[] {
    const out = new Set<string>();
    for (const s of this.expandPos(pos)) if (Array.isArray(s.required)) for (const r of s.required) if (typeof r === 'string') out.add(r);
    return [...out];
  }

  nameIndex(pos: Pos): NameIndex {
    return new NameIndex([...this.propsOf(pos).keys(), ...this.requiredOf(pos)]);
  }

  /** Additional properties allowed (arguments.md: "根对象允许任意字段"). */
  allowsExtra(pos: Pos): boolean {
    return !this.expandPos(pos).some((s) => s.additionalProperties === false || s.unevaluatedProperties === false);
  }

  /** The schemas that describe `key` of the object at `pos`. */
  child(pos: Pos, key: string): Pos {
    const hit = this.propsOf(pos).get(key);
    if (hit) return hit;
    const expanded = this.expandPos(pos);
    for (const s of expanded) {
      if (!isPlainObject(s.patternProperties)) continue;
      for (const [pattern, sub] of Object.entries(s.patternProperties)) {
        try {
          if (new RegExp(pattern, 'u').test(key)) return [sub as JsonSchema];
        } catch {
          // ignore patterns JavaScript cannot parse
        }
      }
    }
    for (const s of expanded) {
      const ap = s.additionalProperties;
      if (isPlainObject(ap)) return [ap as JsonSchema];
    }
    return [];
  }

  /** The schemas that describe the elements of the array at `pos`. */
  items(pos: Pos, index?: number): Pos {
    const out: JsonSchema[] = [];
    for (const s of this.expandPos(pos)) {
      if (Array.isArray(s.prefixItems) && index !== undefined && index < s.prefixItems.length) {
        out.push(s.prefixItems[index] as JsonSchema);
        continue;
      }
      const it = s.items;
      if (Array.isArray(it)) {
        if (index !== undefined && index < it.length) out.push(it[index] as JsonSchema);
      } else if (isPlainObject(it)) out.push(it as JsonSchema);
    }
    return out;
  }

  /** `const` or a single-valued `enum` (the fields anyOf/oneOf completion can fill in). */
  singleValue(s: unknown): { value: unknown } | undefined {
    const r = this.resolve(s);
    if ('const' in r) return { value: r.const };
    if (Array.isArray(r.enum) && r.enum.length === 1) return { value: r.enum[0] };
    return undefined;
  }

  /** Allowed literal values of a schema: `enum`, `const`, or an anyOf/oneOf made only of constants. */
  literals(s: unknown, depth = 0): unknown[] | undefined {
    const r = this.resolve(s);
    if (Array.isArray(r.enum) && r.enum.length > 0) return r.enum;
    if ('const' in r) return [r.const];
    if (depth < 2) {
      for (const key of ['anyOf', 'oneOf'] as const) {
        const list = r[key];
        if (Array.isArray(list) && list.length > 0) {
          const all: unknown[] = [];
          for (const b of list) {
            const l = this.literals(b, depth + 1);
            if (!l) return undefined;
            all.push(...l);
          }
          return all;
        }
      }
    }
    return undefined;
  }

  /** Display spelling of an argument path (`--filter.state`, `--labels[1]`), from schema-aware segments. */
  displayArg(segments: ReadonlyArray<string | number>): string {
    if (segments.length === 0) return '(arguments)';
    let pos: Pos = [this.root];
    let out = '--';
    let first = true;
    for (const seg of segments) {
      if (typeof seg === 'number') {
        out += `[${seg}]`;
        pos = this.items(pos, seg);
        continue;
      }
      const name = this.nameIndex(pos).show(seg);
      if (first) out += rootFlagName(name);
      else out += `.${name}`;
      first = false;
      pos = this.child(pos, seg);
    }
    return out;
  }
}

/** Top-level parameters that collide with a global option (or `--args`) are addressed as `--p.<name>`. */
export function rootFlagName(display: string): string {
  return GLOBAL_OPTION_NAMES.has(display) || display === 'args' ? `p.${display}` : display;
}
