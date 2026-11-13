// `--pick a,b.c` (output.md, "选字段"): keep only the named fields of a result, in the order asked for.
// Pure functions over cleaned JSON values; nothing here knows about a server or a tool.

type Row = Record<string, unknown>;

const isObject = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `createdAt`, `created_at` and `created-at` name the same field. */
const norm = (name: string): string => name.toLowerCase().replace(/[-_\s]/g, '');

/** The key of `obj` a name means: the exact key first, then the one that differs only in case and separators. */
function findKey(obj: Row, name: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(obj, name)) return name;
  const wanted = norm(name);
  if (wanted === '') return undefined;
  return Object.keys(obj).find((key) => norm(key) === wanted);
}

interface Hit {
  /** The keys walked, as the result spells them; `priority.name` in the header of a table. */
  path: string[];
  /** The value at the end of the path; through an array, one value per element that has it. */
  value: unknown;
  /** The object cut down to this path, for `-o json`. */
  pruned: Row;
}

/** One name against one object: the whole name as a key first, then `head.rest` at each dot. */
function hit(obj: Row, name: string): Hit | undefined {
  const whole = findKey(obj, name);
  if (whole !== undefined) return { path: [whole], value: obj[whole], pruned: { [whole]: obj[whole] } };
  for (let dot = name.indexOf('.'); dot > 0; dot = name.indexOf('.', dot + 1)) {
    const head = findKey(obj, name.slice(0, dot));
    if (head === undefined) continue;
    const rest = name.slice(dot + 1);
    const child = obj[head];
    if (isObject(child)) {
      const inner = hit(child, rest);
      if (inner) return { path: [head, ...inner.path], value: inner.value, pruned: { [head]: inner.pruned } };
    } else if (Array.isArray(child)) {
      const inner = child.map((item) => (isObject(item) ? hit(item, rest) : undefined)).filter((h): h is Hit => h !== undefined);
      if (inner.length > 0) return { path: [head, ...inner[0]!.path], value: inner.map((h) => h.value), pruned: { [head]: inner.map((h) => h.pruned) } };
    }
  }
  return undefined;
}

/** Deep merge of two cut-down objects that came from the same source (`a.b` and `a.c` both keep part of `a`). */
function merge(into: Row, from: Row): Row {
  for (const [key, value] of Object.entries(from)) {
    const have = into[key];
    if (isObject(have) && isObject(value)) into[key] = merge({ ...have }, value);
    else if (Array.isArray(have) && Array.isArray(value) && have.length === value.length && have.every(isObject) && value.every(isObject)) {
      into[key] = have.map((item, i) => merge({ ...(item as Row) }, value[i] as Row));
    } else if (!(key in into)) into[key] = value;
  }
  return into;
}

export interface PickOutcome {
  /** The value with the selection applied; the value itself when no name matched anything. */
  value: unknown;
  /** Names that matched no field anywhere, as typed. */
  unknown: string[];
  /** Field names at the place the selection applied to (or, when nothing matched, would have applied to). */
  available: string[];
  /**
   * Arrays whose rows were cut down, with their columns in the order asked for: the text
   * rendering shows exactly these as a table, without the column limit.
   */
  tables: WeakMap<object, string[]>;
}

/**
 * Apply `--pick`. The selection applies at the outermost place where a name matches: the rows of
 * an array of objects, or the keys of an object. Where nothing matches, the search goes one level
 * down (a wrapper such as `{ issues: [...], totalCount }` keeps its other keys). `flat` is the text
 * rendering: a dotted name becomes one column (`priority.name`); otherwise the nesting is kept.
 */
export function pickValue(value: unknown, names: readonly string[], flat: boolean): PickOutcome {
  const matched = new Set<string>();
  const tables = new WeakMap<object, string[]>();
  // Where the names are looked up, for the message about one that matched nothing: the first place
  // the selection applied; failing that the rows of the first table, then the first object.
  let appliedKeys: string[] | undefined;
  let tableKeys: string[] | undefined;
  let objectKeys: string[] | undefined;
  const keysOf = (rows: readonly Row[]): string[] => [...new Set(rows.flatMap((row) => Object.keys(row)))];

  const cut = (obj: Row): Row => {
    const row: Row = {};
    for (const name of names) {
      const found = hit(obj, name);
      if (!found) continue;
      matched.add(name);
      if (flat) row[found.path.join('.')] ??= found.value;
      else merge(row, found.pruned);
    }
    return row;
  };

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      const rows = node.filter(isObject);
      if (rows.some((row) => names.some((name) => hit(row, name) !== undefined))) {
        appliedKeys ??= keysOf(rows);
        const out = node.map((item) => (isObject(item) ? cut(item) : item));
        // Columns in the order asked for, not in the order the first rows happened to have them.
        if (flat) tables.set(out, [...new Set(names.flatMap((name) => rows.flatMap((row) => hit(row, name)?.path.join('.') ?? [])))]);
        return out;
      }
      if (rows.length > 0) tableKeys ??= keysOf(rows);
      return node.map(walk);
    }
    if (isObject(node)) {
      if (names.some((name) => hit(node, name) !== undefined)) {
        appliedKeys ??= Object.keys(node);
        return cut(node);
      }
      objectKeys ??= Object.keys(node);
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    }
    return node;
  };

  const picked = walk(value);
  return {
    value: appliedKeys ? picked : value,
    unknown: names.filter((name) => !matched.has(name)),
    available: appliedKeys ?? tableKeys ?? objectKeys ?? [],
    tables,
  };
}
