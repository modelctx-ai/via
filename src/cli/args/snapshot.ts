// Schema snapshot check (arguments.md, "schema 快照校验"): the `inputSchema` and `outputSchema` a
// tool has now against the ones saved earlier (`-h -o json`), so a script or a CI job finds out that
// the server changed a tool before it sends a call that depends on the old shape.
//
// Two modes. `compatible`: what a caller written against the snapshot relies on still holds. On the
// input side that is every call that was valid (a parameter may be added if optional, a type or an
// enum may widen); on the output side every field the snapshot declares is still there with a type
// that fits (a field may be added, a type may narrow). `strict`: the two schemas are equal.
import type { JsonSchema, McpTool } from '../../catalog/types';
import { isPlainObject, type NameIndex, type Pos, rootFlagName, SchemaModel } from './schema';

export type SchemaMode = 'compatible' | 'strict';

export interface SchemaChange {
  side: 'input' | 'output';
  /** `--filter.state` on the input side, `items[].id` on the output side; in `strict` mode the path inside the schema. */
  path: string;
  /** What changed, for `-o json`: `added`, `removed`, `required`, `optional`, `type`, `enum`, `schema` (a whole schema appeared or went), `differs` (strict). */
  kind: 'added' | 'removed' | 'required' | 'optional' | 'type' | 'enum' | 'schema' | 'differs';
  message: string;
  /** A caller or consumer written against the snapshot can break (always true in `strict` mode). */
  breaking: boolean;
}

export interface Snapshot {
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  /** The tool's original name, when the snapshot says (a `-h -o json` file does; so does a raw `tools/list` entry). */
  rawName?: string;
}

/** The snapshot a file holds: a tool detail (`-h -o json`) or an MCP tool object. A string is the reason it is not one. */
export function readSnapshot(value: unknown): Snapshot | string {
  if (!isPlainObject(value)) return 'expected a JSON object (the output of `via <tool> -h -o json`)';
  const input = value.inputSchema;
  const output = value.outputSchema;
  if (input === undefined && output === undefined) return 'it has neither inputSchema nor outputSchema; save it with `via <tool> -h -o json`';
  if (input !== undefined && !isPlainObject(input)) return 'inputSchema is not an object';
  if (output !== undefined && !isPlainObject(output)) return 'outputSchema is not an object';
  const name = typeof value.rawName === 'string' ? value.rawName : typeof value.name === 'string' ? value.name : undefined;
  return { ...(input ? { inputSchema: input as JsonSchema } : {}), ...(output ? { outputSchema: output as JsonSchema } : {}), ...(name !== undefined ? { rawName: name } : {}) };
}

/** The tool detail `-h -o json` prints, and the file this check reads back. */
export function toolDetail(tool: McpTool, ref: string, flags: { readOnly: boolean; destructive: boolean; destructiveBy?: string | undefined }): Record<string, unknown> {
  return {
    tool: ref,
    rawName: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(flags.readOnly ? { readOnly: true } : {}),
    ...(flags.destructive ? { destructive: true, ...(flags.destructiveBy ? { destructiveBy: flags.destructiveBy } : {}) } : {}),
    inputSchema: tool.inputSchema ?? { type: 'object' },
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  };
}

/** Every difference between the snapshot and the tool as it is now; empty when they agree. */
export function compareSnapshot(snapshot: Snapshot, tool: McpTool, mode: SchemaMode): SchemaChange[] {
  const out: SchemaChange[] = [];
  const sides = [
    ['input', snapshot.inputSchema, tool.inputSchema],
    ['output', snapshot.outputSchema, tool.outputSchema],
  ] as const;
  for (const [side, before, now] of sides) {
    if (mode === 'strict') {
      if (before === undefined && now === undefined) continue;
      if (before === undefined || now === undefined) {
        out.push({ side, path: '', kind: 'schema', message: before === undefined ? `${side}Schema was added` : `${side}Schema was removed`, breaking: true });
        continue;
      }
      diffJson(side, before, now, '', out);
    } else {
      compareSide(side, before, now, out);
    }
  }
  return out;
}

// compatible ------------------------------------------------------------------------------------

const MAX_DEPTH = 6;

function compareSide(side: 'input' | 'output', before: JsonSchema | undefined, now: JsonSchema | undefined, out: SchemaChange[]): void {
  if (before === undefined && now === undefined) return;
  if (before === undefined) {
    // A new outputSchema promises more; a new inputSchema where nothing was declared is only a description.
    if (side === 'output') out.push({ side, path: '', kind: 'schema', message: 'outputSchema was added', breaking: false });
    return;
  }
  if (now === undefined) {
    // Without the schema nothing says the fields are still there; an input schema that went has no parameters left to check.
    out.push({ side, path: '', kind: 'schema', message: `${side}Schema was removed`, breaking: side === 'output' });
    return;
  }
  new Walker(side, new SchemaModel(before), new SchemaModel(now), out).object([before], [now], '', 0);
}

/** `typeInfo` types as a set, or undefined when the schema does not say. */
function typesOf(model: SchemaModel, pos: Pos): Set<string> | undefined {
  const info = model.typeInfoPos(pos);
  return info.known && info.types.size > 0 ? info.types : undefined;
}

/** Every type in `a` is a type in `b` (an integer is a number). */
function within(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const t of a) if (!b.has(t) && !(t === 'integer' && b.has('number'))) return false;
  return true;
}

function literalsOf(model: SchemaModel, pos: Pos): unknown[] | undefined {
  for (const s of pos) {
    const found = model.literals(s);
    if (found) return found;
  }
  return undefined;
}

const show = (types: ReadonlySet<string>): string => [...types].sort().join('|');
const showValues = (values: readonly unknown[]): string => {
  const text = values.slice(0, 3).map((v) => JSON.stringify(v).slice(0, 24));
  return `${text.join(', ')}${values.length > 3 ? ', …' : ''}`;
};

class Walker {
  constructor(
    private readonly side: 'input' | 'output',
    private readonly before: SchemaModel,
    private readonly now: SchemaModel,
    private readonly out: SchemaChange[],
  ) {}

  private add(path: string, kind: SchemaChange['kind'], message: string, breaking: boolean): void {
    this.out.push({ side: this.side, path, kind, message, breaking });
  }

  /** `--name` for a top-level parameter, `.field` below it; output fields are plain `a.b`. */
  private label(parent: string, name: string, names: NameIndex): string {
    const shown = names.show(name);
    if (this.side === 'output') return parent === '' ? shown : `${parent}.${shown}`;
    return parent === '' ? `--${rootFlagName(shown)}` : `${parent}.${shown}`;
  }

  object(posBefore: Pos, posNow: Pos, parent: string, depth: number): void {
    const propsBefore = this.before.propsOf(posBefore);
    const propsNow = this.now.propsOf(posNow);
    const requiredBefore = new Set(this.before.requiredOf(posBefore));
    const requiredNow = new Set(this.now.requiredOf(posNow));
    const namesBefore = this.before.nameIndex(posBefore);
    const namesNow = this.now.nameIndex(posNow);
    const input = this.side === 'input';
    const all = new Set([...propsBefore.keys(), ...requiredBefore, ...propsNow.keys(), ...requiredNow]);
    for (const name of all) {
      const hadBefore = propsBefore.has(name) || requiredBefore.has(name);
      const hasNow = propsNow.has(name) || requiredNow.has(name);
      const wasRequired = requiredBefore.has(name);
      const isRequired = requiredNow.has(name);
      if (hadBefore && !hasNow) {
        const path = this.label(parent, name, namesBefore);
        if (input) this.add(path, 'removed', `${wasRequired ? 'required ' : ''}parameter removed`, true);
        else this.add(path, 'removed', `${wasRequired ? 'required ' : ''}field removed`, wasRequired);
        continue;
      }
      if (!hadBefore && hasNow) {
        const path = this.label(parent, name, namesNow);
        if (input) this.add(path, 'added', isRequired ? 'new required parameter' : 'new optional parameter', isRequired);
        else this.add(path, 'added', 'new field', false);
        continue;
      }
      const path = this.label(parent, name, namesNow);
      if (input && !wasRequired && isRequired) this.add(path, 'required', 'optional parameter became required', true);
      else if (input && wasRequired && !isRequired) this.add(path, 'optional', 'required parameter became optional', false);
      else if (!input && wasRequired && !isRequired) this.add(path, 'optional', 'required field became optional', true);
      else if (!input && !wasRequired && isRequired) this.add(path, 'required', 'optional field became required', false);
      this.value(this.before.child(posBefore, name), this.now.child(posNow, name), path, depth + 1);
    }
  }

  /** The type, the allowed values and the structure of one parameter or field. */
  private value(posBefore: Pos, posNow: Pos, path: string, depth: number): void {
    const typesBefore = typesOf(this.before, posBefore);
    const typesNow = typesOf(this.now, posNow);
    const input = this.side === 'input';
    if (typesBefore && typesNow && !(input ? within(typesBefore, typesNow) : within(typesNow, typesBefore))) {
      this.add(path, 'type', `type changed: ${show(typesBefore)} -> ${show(typesNow)}`, true);
      return;
    }
    const valuesBefore = literalsOf(this.before, posBefore);
    const valuesNow = literalsOf(this.now, posNow);
    if (input && valuesBefore) {
      // Callers may send any value the snapshot allowed: the allowed set may only grow.
      const lost = valuesBefore.filter((v) => valuesNow && !valuesNow.some((w) => JSON.stringify(w) === JSON.stringify(v)));
      if (valuesNow && lost.length > 0) this.add(path, 'enum', `allowed values removed: ${showValues(lost)}`, true);
    } else if (input && valuesNow && !valuesBefore) {
      this.add(path, 'enum', `now limited to: ${showValues(valuesNow)}`, true);
    } else if (!input && valuesBefore && valuesNow) {
      // Consumers handle the values the snapshot lists: the values sent may only shrink.
      const extra = valuesNow.filter((v) => !valuesBefore.some((w) => JSON.stringify(w) === JSON.stringify(v)));
      if (extra.length > 0) this.add(path, 'enum', `new values: ${showValues(extra)}`, true);
    }
    if (depth >= MAX_DEPTH) return;
    if (typesBefore?.has('object') && typesNow?.has('object')) this.object(posBefore, posNow, path, depth);
    if (typesBefore?.has('array') && typesNow?.has('array')) {
      const itemsBefore = this.before.items(posBefore);
      const itemsNow = this.now.items(posNow);
      if (itemsBefore.length > 0 && itemsNow.length > 0) this.value(itemsBefore, itemsNow, `${path}[]`, depth + 1);
    }
  }
}

// strict ----------------------------------------------------------------------------------------

const MAX_STRICT_CHANGES = 40;

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

/** Objects with their keys in order, so that two schemas that differ only in key order are equal. */
function sortKeys(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    const items = value.map((v) => sortKeys(v));
    // `required` is a set
    return key === 'required' ? items.map((v) => JSON.stringify(v)).sort() : items;
  }
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k], k)]));
}

function brief(value: unknown): string {
  const text = JSON.stringify(value) ?? 'undefined';
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

function diffJson(side: 'input' | 'output', before: unknown, now: unknown, path: string, out: SchemaChange[]): void {
  if (out.length >= MAX_STRICT_CHANGES || sameJson(before, now)) return;
  const here = path === '' ? '(schema)' : path;
  if (isPlainObject(before) && isPlainObject(now)) {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(now)])].sort()) {
      const child = path === '' ? key : `${path}.${key}`;
      if (out.length >= MAX_STRICT_CHANGES) return;
      if (!(key in before)) out.push({ side, path: child, kind: 'differs', message: `added: ${brief(now[key])}`, breaking: true });
      else if (!(key in now)) out.push({ side, path: child, kind: 'differs', message: `removed (was ${brief(before[key])})`, breaking: true });
      else diffJson(side, before[key], now[key], child, out);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(now) && path.endsWith('required')) {
    const had = new Set(before.map(String));
    const has = new Set(now.map(String));
    for (const name of has) if (!had.has(name)) out.push({ side, path: here, kind: 'differs', message: `added: ${name}`, breaking: true });
    for (const name of had) if (!has.has(name)) out.push({ side, path: here, kind: 'differs', message: `removed: ${name}`, breaking: true });
    return;
  }
  out.push({ side, path: here, kind: 'differs', message: `changed: ${brief(before)} -> ${brief(now)}`, breaking: true });
}
