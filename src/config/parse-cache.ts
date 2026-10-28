// A cache of parsed YAML configuration files (config.md, "解析缓存").
//
// Importing the YAML library and parsing even a tiny file costs 10 ms on a cold start, and via's own
// `config.yaml` is read by every command. The cache is keyed by the SHA-256 of the file's bytes, so
// it can never describe a different file: edit the file and the key changes. The trust check is not
// involved - it hashes the same bytes itself.
//
// What is stored is the *shape* of the parsed document, not its text: maps, lists, numbers and
// booleans, and for every string a pair of offsets into the file. Reading rebuilds the strings from
// the file that was just read, so a credential written into a config file is never copied into the
// cache directory. A document is only cached when rebuilding it reproduces the parse result exactly;
// anything the shape cannot express (aliases, escape sequences, multi-line scalars, non-finite
// numbers) is parsed every time, as before.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPlainObject } from './model';

/** Bumped when the stored shape changes. */
const SHAPE_VERSION = 1;

/** Files kept; the oldest are removed beyond this many. */
const KEEP = 16;

/**
 * Map: `{ m: [key, value, key, value, ...] }`, list: `{ s: [...] }`, string: `[start, end]` offsets
 * into the source text, anything else (number, boolean, null): itself.
 */
type Shape = number | boolean | null | [number, number] | { m: Shape[] } | { s: Shape[] };

interface CacheFile {
  v: number;
  /** Identifies the parser: via's version and the YAML library's. */
  id: string;
  shape: Shape;
}


/** The document as a shape, or undefined when it cannot be expressed that way. */
export function shapeOf(node: unknown, source: string, yaml: typeof import('yaml')): Shape | undefined {
  if (node === null || node === undefined) return null;
  if (yaml.isAlias(node)) return undefined;
  if (yaml.isScalar(node)) {
    const value = node.value;
    if (value === null) return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : undefined;
    if (typeof value !== 'string' || !node.range) return undefined;
    // The string must be a plain slice of the file: a plain scalar as written, or a quoted one
    // without escapes or doubled quotes.
    const [start, end] = node.range;
    const type = node.type;
    const [from, to] = type === 'QUOTE_DOUBLE' || type === 'QUOTE_SINGLE' ? [start + 1, end - 1] : [start, end];
    return source.slice(from, to) === value ? [from, to] : undefined;
  }
  if (yaml.isMap(node)) {
    const out: Shape[] = [];
    for (const pair of node.items) {
      const key = shapeOf(pair.key, source, yaml);
      // Keys are strings in via's files; a number or boolean key is expressed too (it is stringified by toJS).
      if (key === undefined || !Array.isArray(key)) return undefined;
      const value = shapeOf(pair.value, source, yaml);
      if (value === undefined) return undefined;
      out.push(key, value);
    }
    return { m: out };
  }
  if (yaml.isSeq(node)) {
    const out: Shape[] = [];
    for (const item of node.items) {
      const shape = shapeOf(item, source, yaml);
      if (shape === undefined) return undefined;
      out.push(shape);
    }
    return { s: out };
  }
  return undefined;
}

/** The value a shape describes, taking its strings from `source`. Throws on a shape that does not fit. */
export function valueOf(shape: unknown, source: string): unknown {
  if (Array.isArray(shape)) {
    const [from, to] = shape as unknown[];
    if (typeof from !== 'number' || typeof to !== 'number' || shape.length !== 2 || from < 0 || to > source.length || from > to) throw new Error('bad offsets');
    return source.slice(from, to);
  }
  if (shape === null || typeof shape === 'number' || typeof shape === 'boolean') return shape;
  if (isPlainObject(shape) && Array.isArray(shape.m)) {
    const items = shape.m as unknown[];
    if (items.length % 2 !== 0) throw new Error('bad map');
    const out: Record<string, unknown> = {};
    for (let i = 0; i < items.length; i += 2) {
      const key = valueOf(items[i], source) as string;
      // Define, not assign: a "__proto__" key is data (the YAML library does the same).
      Object.defineProperty(out, key, { value: valueOf(items[i + 1], source), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  if (isPlainObject(shape) && Array.isArray(shape.s)) return (shape.s as unknown[]).map((item) => valueOf(item, source));
  throw new Error('bad shape');
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const keys = Object.keys(a);
    const other = Object.keys(b);
    return keys.length === other.length && keys.every((k, i) => k === other[i] && sameValue(a[k], b[k]));
  }
  return Object.is(a, b);
}

export class ParseCache {
  constructor(
    /** `<cache dir>/config` */
    private readonly dir: string,
    /** Identifies the parser (see `CacheFile.id`). */
    private readonly id: string,
  ) {}

  private file(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  /** The parsed document of the file with this content hash, rebuilt from `source`; undefined on a miss. */
  get(key: string, source: string): { value: unknown } | undefined {
    try {
      const data = JSON.parse(readFileSync(this.file(key), 'utf8')) as Partial<CacheFile> | null;
      if (!data || data.v !== SHAPE_VERSION || data.id !== this.id) return undefined;
      return { value: valueOf(data.shape, source) };
    } catch {
      return undefined;
    }
  }

  /**
   * Remember how `document` (the YAML library's parse of `source`) came out, if a shape can say so.
   * Best effort: a cache that cannot be written must never fail a command.
   */
  put(key: string, source: string, document: unknown, parsed: unknown, yaml: typeof import('yaml')): void {
    try {
      const shape = shapeOf(document, source, yaml);
      if (shape === undefined) return;
      // Only a shape that rebuilds the parse result exactly is worth keeping.
      if (!sameValue(valueOf(shape, source), parsed)) return;
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const file = this.file(key);
      const tmp = `${file}.${process.pid}.tmp`;
      const body: CacheFile = { v: SHAPE_VERSION, id: this.id, shape };
      writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
      renameSync(tmp, file);
      this.prune(file);
    } catch {
      // ignore
    }
  }

  /** Keep the newest `KEEP` files; old config versions would otherwise pile up. */
  private prune(keep: string): void {
    try {
      const files = readdirSync(this.dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => ({ path: join(this.dir, name), mtime: statSync(join(this.dir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : 1));
      for (const file of files.slice(KEEP)) if (file.path !== keep) rmSync(file.path, { force: true });
    } catch {
      // ignore
    }
  }
}
