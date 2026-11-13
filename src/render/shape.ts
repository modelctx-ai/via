import type { ColumnsData } from './rules';
import { alignRows, truncateChars } from './width';

// Shape detection and text layout (output.md, step 3). Pure functions over cleaned JSON values.

export interface ShapeOptions {
  /** Table cells longer than this many characters are cut and end with `…`. Undefined: no cut (`--full`). */
  cellWidth: number | undefined;
  columns: ColumnsData;
  /** Arrays whose columns `--pick` chose (pick.ts): a table of exactly these columns, in this order. */
  picked?: WeakMap<object, string[]>;
}

export type ShapeKind = 'table' | 'object' | 'list' | 'scalar';

export interface Shaped {
  kind: ShapeKind;
  lines: string[];
  /** Leading lines to repeat on continuation pages; only set when the whole output is one table. */
  header: string[];
  /** Number of data rows for tables and lists. */
  rows?: number;
  /** Columns left out of tables (all tables counted), for the `+N cols` meta field. */
  hiddenColumns: number;
  /** Their names, in the order they first appear; a name left out of two tables is listed once. */
  hiddenNames: string[];
}

/** What the tables of one result left out. */
interface Hidden {
  count: number;
  names: string[];
}

const noHidden = (): Hidden => ({ count: 0, names: [] });

function addHidden(acc: Hidden, t: { hidden: string[] }): void {
  acc.count += t.hidden.length;
  for (const name of t.hidden) if (!acc.names.includes(name)) acc.names.push(name);
}

type Row = Record<string, unknown>;

const isObject = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

interface TableKeys {
  /** Keys shared by enough rows to be columns. */
  keys: string[];
  /** Every key any row has, in the order they first appear. */
  all: string[];
  /** The columns were chosen with `--pick`: all of them are shown, in this order. */
  picked?: boolean;
}

/** Keys shared by "enough" rows, or undefined when the array is not a consistent list of objects. */
function tableKeys(items: readonly unknown[], opts: ShapeOptions): TableKeys | undefined {
  if (items.length < 2 || !items.every(isObject)) return undefined;
  const picked = opts.picked?.get(items);
  if (picked) return picked.length > 0 ? { keys: picked, all: picked, picked: true } : undefined;
  const rows = items as Row[];
  const count = new Map<string, number>();
  for (const row of rows) for (const key of Object.keys(row)) count.set(key, (count.get(key) ?? 0) + 1);
  const common = [...count.entries()].filter(([, n]) => n >= rows.length / 2).map(([k]) => k);
  if (common.length === 0 || common.length / count.size < 0.5) return undefined;
  return { keys: common, all: [...count.keys()] };
}

/** A cell that is one URL and nothing else: it is shown whole, since a URL cut short opens nothing. */
const WHOLE_URL = /^https?:\/\/\S+$/;

/** Whether a column would mostly be cut: more than half of its cells are longer than a cell may be. */
function mostlyCut(rows: readonly Row[], key: string, opts: ShapeOptions): boolean {
  if (opts.cellWidth === undefined) return false;
  let present = 0;
  let long = 0;
  for (const row of rows) {
    if (row[key] === undefined) continue;
    present += 1;
    const text = cellText(row[key], opts.columns).replace(/\s+/g, ' ').trim();
    if (!WHOLE_URL.test(text) && Array.from(text).length > opts.cellWidth) long += 1;
  }
  return long * 2 > present;
}

/**
 * Pick at most `maxColumns` columns: preferred field names first, then the remaining in key order,
 * those whose cells fit before those that would mostly be cut (a `description` shortened to its
 * first words tells less than the `priority` it would push out).
 */
function chooseColumns(keys: readonly string[], rows: readonly Row[], opts: ShapeOptions): string[] {
  const { columns } = opts;
  const chosen = new Set<string>();
  for (const name of columns.priority) {
    if (chosen.size >= columns.maxColumns) break;
    if (keys.includes(name)) chosen.add(name);
  }
  if (chosen.size < columns.maxColumns && chosen.size < keys.length) {
    const rest = keys.filter((k) => !chosen.has(k));
    const cut = new Set(rest.filter((k) => mostlyCut(rows, k, opts)));
    for (const key of [...rest.filter((k) => !cut.has(k)), ...rest.filter((k) => cut.has(k))]) {
      if (chosen.size >= columns.maxColumns) break;
      chosen.add(key);
    }
  }
  return keys.filter((k) => chosen.has(k)); // display in the order fields first appear
}

function label(obj: Row, columns: ColumnsData): string {
  for (const key of columns.labelKeys) {
    const v = obj[key];
    if (isScalar(v)) return String(v);
  }
  return JSON.stringify(obj);
}

function cellText(value: unknown, columns: ColumnsData): string {
  if (value === undefined) return '-';
  if (isScalar(value)) return String(value);
  if (Array.isArray(value)) {
    return value.map((v) => (isScalar(v) ? String(v) : isObject(v) ? label(v, columns) : JSON.stringify(v))).join(', ');
  }
  if (isObject(value)) return label(value, columns);
  return String(value);
}

function table(items: readonly unknown[], keys: TableKeys, opts: ShapeOptions, indent: string) {
  const shown = keys.picked ? keys.keys : chooseColumns(keys.keys, items as Row[], opts);
  const cell = (v: unknown) => {
    const flat = cellText(v, opts.columns).replace(/\s+/g, ' ').trim();
    return opts.cellWidth === undefined || WHOLE_URL.test(flat) ? flat : truncateChars(flat, opts.cellWidth);
  };
  const rows = [shown, ...(items as Row[]).map((r) => shown.map((k) => cell(r[k])))];
  return {
    lines: alignRows(rows).map((l) => indent + l),
    rows: items.length,
    hidden: keys.all.filter((k) => !shown.includes(k)),
  };
}

function scalarLines(value: string | number | boolean, indent: string): string[] {
  return String(value)
    .split('\n')
    .map((l) => indent + l);
}

function listLines(items: readonly unknown[], opts: ShapeOptions, indent: string, acc: Hidden): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (isScalar(item)) {
      const [first = '', ...rest] = String(item).split('\n');
      out.push(`${indent}- ${first}`, ...rest.map((l) => `${indent}  ${l}`));
    } else if (isObject(item)) {
      const block = objectLines(item, opts, `${indent}  `, acc);
      block[0] = `${indent}- ${block[0]!.slice(indent.length + 2)}`;
      out.push(...block);
    } else {
      out.push(`${indent}- ${JSON.stringify(item)}`);
    }
  }
  return out;
}

function objectLines(obj: Row, opts: ShapeOptions, indent: string, acc: Hidden): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (isScalar(value)) {
      const text = String(value);
      if (text.includes('\n')) out.push(`${indent}${key}:`, ...text.split('\n').map((l) => `${indent}  ${l}`));
      else out.push(`${indent}${key}: ${text}`);
    } else if (Array.isArray(value)) {
      if (value.every(isScalar) && !value.some((v) => String(v).includes('\n'))) {
        out.push(`${indent}${key}: ${value.join(', ')}`);
        continue;
      }
      // `[{name: bug}, {name: p1}]` reads best as `bug, p1`; rows cut down by `--pick` stay a table with its header.
      const singles = opts.picked?.has(value) ? [undefined] : value.map((v) => (isObject(v) && Object.keys(v).length === 1 ? Object.values(v)[0] : undefined));
      if (singles.every((v) => isScalar(v) && !String(v).includes('\n'))) {
        out.push(`${indent}${key}: ${singles.join(', ')}`);
        continue;
      }
      const keys = tableKeys(value, opts);
      out.push(`${indent}${key}:`);
      if (keys) {
        const t = table(value, keys, opts, `${indent}  `);
        addHidden(acc, t);
        out.push(...t.lines);
      } else {
        out.push(...listLines(value, opts, `${indent}  `, acc));
      }
    } else if (isObject(value)) {
      out.push(`${indent}${key}:`, ...objectLines(value, opts, `${indent}  `, acc));
    } else {
      out.push(`${indent}${key}: ${JSON.stringify(value)}`);
    }
  }
  return out;
}

/**
 * Lay a cleaned value out as text:
 * - array of consistent objects (two or more) -> aligned table, at most `maxColumns` columns;
 * - single object (or one-element array) -> `key: value` lines, nested objects indented two spaces;
 * - anything else -> one item per line.
 */
export function shapeValue(value: unknown, opts: ShapeOptions): Shaped {
  const acc = noHidden();
  const hidden = (): Pick<Shaped, 'hiddenColumns' | 'hiddenNames'> => ({ hiddenColumns: acc.count, hiddenNames: acc.names });
  if (Array.isArray(value)) {
    const keys = tableKeys(value, opts);
    if (keys) {
      const t = table(value, keys, opts, '');
      addHidden(acc, t);
      return { kind: 'table', lines: t.lines, header: t.lines.slice(0, 1), rows: t.rows, ...hidden() };
    }
    if (value.length === 1 && isObject(value[0])) {
      return { kind: 'object', lines: objectLines(value[0], opts, '', acc), header: [], rows: 1, ...hidden() };
    }
    const lines = value.every(isScalar) ? value.flatMap((v) => scalarLines(v as string, '')) : listLines(value, opts, '', acc);
    return { kind: 'list', lines, header: [], rows: value.length, ...hidden() };
  }
  if (isObject(value)) {
    return { kind: 'object', lines: objectLines(value, opts, '', acc), header: [], ...hidden() };
  }
  if (isScalar(value)) return { kind: 'scalar', lines: scalarLines(value, ''), header: [], ...hidden() };
  return { kind: 'scalar', lines: [], header: [], ...hidden() };
}
