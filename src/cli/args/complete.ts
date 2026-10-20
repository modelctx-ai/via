// anyOf / oneOf auto-completion (arguments.md): when the fields already given pick exactly one
// branch, fill in that branch's single-valued fields (`const` or a one-value `enum`).
import type { JsonSchema } from '../../catalog/types';
import { isPlainObject, type Pos, SchemaModel } from './schema';

export function completeAlternatives(model: SchemaModel, args: Record<string, unknown>): void {
  visit(model, [model.root], args, 0);
}

function visit(model: SchemaModel, pos: Pos, value: unknown, depth: number): void {
  if (depth > 10) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => visit(model, model.items(pos, i), v, depth + 1));
    return;
  }
  if (!isPlainObject(value)) return;

  const chosen: JsonSchema[] = [];
  if (Object.keys(value).length > 0) {
    for (const { options } of model.branches(pos)) {
      const matching: JsonSchema[][] = options.filter((b: JsonSchema[]) => compatible(model, b, value));
      if (matching.length !== 1) continue;
      const branch: JsonSchema[] = matching[0]!;
      for (const [name, schemas] of model.propsOf(branch) as Map<string, JsonSchema[]>) {
        if (name in value) continue;
        const single = schemas.map((s) => model.singleValue(s)).find((x) => x !== undefined);
        if (single) value[name] = single.value;
      }
      chosen.push(...branch);
    }
  }
  const here: Pos = [...pos, ...chosen];
  for (const [key, v] of Object.entries(value)) visit(model, model.child(here, key), v, depth + 1);
}

/** Could `value` be an instance of this branch once its single-valued fields are filled in? */
function compatible(model: SchemaModel, branch: JsonSchema[], value: Record<string, unknown>): boolean {
  const types = model.typeInfoPos(branch);
  if (types.known && !types.types.has('object')) return false;
  const props = model.propsOf(branch);
  const singleOf = (name: string) => {
    for (const s of props.get(name) ?? []) {
      const sv = model.singleValue(s);
      if (sv) return sv;
    }
    return undefined;
  };
  for (const [name, v] of Object.entries(value)) {
    const sv = singleOf(name);
    if (sv && !sameJson(sv.value, v)) return false;
  }
  for (const req of model.requiredOf(branch)) {
    if (req in value) continue;
    if (!singleOf(req)) return false;
  }
  if (!model.allowsExtra(branch)) {
    for (const name of Object.keys(value)) if (!props.has(name)) return false;
  }
  return true;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
