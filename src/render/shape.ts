import type { ColumnsData } from './rules';
import { alignRows, truncateChars } from './width';

// Shape detection and text layout (output.md, step 3). Pure functions over cleaned JSON values.

export interface ShapeOptions {
  /** Table cells longer than this many characters are cut and end with `…`. Undefined: no cut (`--full`). */
  cellWidth: number | undefined;
  columns: ColumnsData;
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
}

type Row = Record<string, unknown>;

const isObject = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** Keys shared by "enough" rows, or undefined when the array is not a consistent list of objects. */
function tableKeys(items: readonly unknown[]): { keys: string[]; all: number } | undefined {
  if (items.length < 2 || !items.every(isObject)) return undefined;
  const rows = items as Row[];
  const count = new Map<string, number>();
  for (const row of rows) for (const key of Object.keys(row)) count.set(key, (count.get(key) ?? 0) + 1);
  const common = [...count.entries()].filter(([, n]) => n >= rows.length / 2).map(([k]) => k);
  if (common.length === 0 || common.length / count.size < 0.5) return undefined;
  return { keys: common, all: count.size };
}

/** Pick at most `max` columns: preferred field names first, then the remaining in key order. */
function chooseColumns(keys: readonly string[], columns: ColumnsData): string[] {
  const chosen = new Set<string>();
  for (const name of columns.priority) {
    if (chosen.size >= columns.maxColumns) break;
    if (keys.includes(name)) chosen.add(name);
  }
  for (const key of keys) {
    if (chosen.size >= columns.maxColumns) break;
    chosen.add(key);
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

function table(items: readonly unknown[], keys: { keys: string[]; all: number }, opts: ShapeOptions, indent: string) {
  const shown = chooseColumns(keys.keys, opts.columns);
  const cell = (v: unknown) => {
    const flat = cellText(v, opts.columns).replace(/\s+/g, ' ').trim();
    return opts.cellWidth === undefined ? flat : truncateChars(flat, opts.cellWidth);
  };
  const rows = [shown, ...(items as Row[]).map((r) => shown.map((k) => cell(r[k])))];
  return {
    lines: alignRows(rows).map((l) => indent + l),
    rows: items.length,
    hidden: keys.all - shown.length,
  };
}

function scalarLines(value: string | number | boolean, indent: string): string[] {
  return String(value)
    .split('\n')
    .map((l) => indent + l);
}

function listLines(items: readonly unknown[], opts: ShapeOptions, indent: string, acc: { hidden: number }): string[] {
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

function objectLines(obj: Row, opts: ShapeOptions, indent: string, acc: { hidden: number }): string[] {
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
      // `[{name: bug}, {name: p1}]` reads best as `bug, p1`.
      const singles = value.map((v) => (isObject(v) && Object.keys(v).length === 1 ? Object.values(v)[0] : undefined));
      if (singles.every((v) => isScalar(v) && !String(v).includes('\n'))) {
        out.push(`${indent}${key}: ${singles.join(', ')}`);
        continue;
      }
      const keys = tableKeys(value);
      out.push(`${indent}${key}:`);
      if (keys) {
        const t = table(value, keys, opts, `${indent}  `);
        acc.hidden += t.hidden;
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
  if (Array.isArray(value)) {
    const keys = tableKeys(value);
    if (keys) {
      const t = table(value, keys, opts, '');
      return { kind: 'table', lines: t.lines, header: t.lines.slice(0, 1), rows: t.rows, hiddenColumns: t.hidden };
    }
    if (value.length === 1 && isObject(value[0])) {
      const acc = { hidden: 0 };
      return { kind: 'object', lines: objectLines(value[0], opts, '', acc), header: [], rows: 1, hiddenColumns: acc.hidden };
    }
    const acc = { hidden: 0 };
    const lines = value.every(isScalar) ? value.flatMap((v) => scalarLines(v as string, '')) : listLines(value, opts, '', acc);
    return { kind: 'list', lines, header: [], rows: value.length, hiddenColumns: acc.hidden };
  }
  if (isObject(value)) {
    const acc = { hidden: 0 };
    return { kind: 'object', lines: objectLines(value, opts, '', acc), header: [], hiddenColumns: acc.hidden };
  }
  if (isScalar(value)) return { kind: 'scalar', lines: scalarLines(value, ''), header: [], hiddenColumns: 0 };
  return { kind: 'scalar', lines: [], header: [], hiddenColumns: 0 };
}
