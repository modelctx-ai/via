// Schema validation with ajv, loaded lazily (implementation.md: ajv must not be on the cold path).
// `import type` only at the top: the static import graph of src/cli/args stays free of ajv.
import type { ErrorObject, default as AjvClass } from 'ajv';
import type { JsonSchema } from '../../catalog/types';

export type { ErrorObject };

type Draft = '2020' | '2019' | 'draft7';

interface Prepared {
  schema: JsonSchema;
  /** Dialects to try, in order. */
  drafts: Draft[];
  externalRefs: string[];
}

export interface Compiled {
  /** Errors of the schema with `format` ignored. Async when the check runs elsewhere (the daemon). */
  check(data: unknown): ErrorObject[] | Promise<ErrorObject[]>;
  /** `format` mismatches of data that passed `check` (warnings only). */
  formats(data: unknown): Promise<ErrorObject[]>;
  warnings: string[];
}

export type CompileResult = { ok: true; compiled: Compiled } | { ok: false; reason: string; warnings: string[] };

/**
 * Turns a schema into something that can check data. The default (`compileSchema`) loads ajv in this
 * process; the daemon backend supplies one that asks the daemon, so ajv stays out of the CLI.
 */
export type SchemaCompiler = (schema: JsonSchema, label: string) => Promise<CompileResult>;

const cache = new WeakMap<object, Promise<CompileResult>>();

/** Compile (once per schema object) an input or output schema. Never throws. */
export function compileSchema(schema: JsonSchema, label: string): Promise<CompileResult> {
  let hit = cache.get(schema);
  if (!hit) {
    hit = doCompile(schema, label).catch((e: unknown): CompileResult => ({ ok: false, reason: reasonOf(e), warnings: [] }));
    cache.set(schema, hit);
  }
  return hit;
}

// Keywords whose value is a map of schemas, or one schema / a list of schemas.
const MAP_KEYS = new Set(['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas']);
const SCHEMA_KEYS = new Set([
  'additionalProperties',
  'unevaluatedProperties',
  'items',
  'additionalItems',
  'unevaluatedItems',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
]);
const LIST_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

/** Copy of the schema without external `$ref`s, `$schema` and the root `$id`. */
function prepare(input: JsonSchema): Prepared {
  const externalRefs: string[] = [];
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node !== 'object' || node === null) return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string' && !v.startsWith('#')) {
        if (!externalRefs.includes(v)) externalRefs.push(v);
        continue; // the part this reference stands for is not validated
      }
      if (MAP_KEYS.has(k) && typeof v === 'object' && v !== null && !Array.isArray(v)) {
        out[k] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, walk(sub)]));
      } else if (SCHEMA_KEYS.has(k) || LIST_KEYS.has(k)) {
        out[k] = walk(v);
      } else if (k === 'dependencies' && typeof v === 'object' && v !== null) {
        out[k] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, Array.isArray(sub) ? sub : walk(sub)]));
      } else {
        out[k] = v; // data (enum, const, default, …) and scalar keywords are kept as they are
      }
    }
    return out;
  };
  const copy = walk(input) as JsonSchema;
  const declared = typeof copy.$schema === 'string' ? copy.$schema : '';
  delete copy.$schema;
  delete copy.$id;
  delete copy.id;
  let drafts: Draft[];
  if (declared.includes('2020-12')) drafts = ['2020'];
  else if (declared.includes('2019-09')) drafts = ['2019'];
  else if (/draft-0[3467]/.test(declared)) drafts = ['draft7'];
  else drafts = ['2020', 'draft7']; // MCP: 2020-12 unless declared; old-style schemas fall back
  return { schema: copy, drafts, externalRefs };
}

type AjvCtor = new (opts: Record<string, unknown>) => AjvClass;

async function loadAjv(draft: Draft): Promise<AjvCtor> {
  const mod: Record<string, unknown> =
    draft === '2020' ? await import('ajv/dist/2020.js') : draft === '2019' ? await import('ajv/dist/2019.js') : await import('ajv');
  return ((mod.default as { default?: unknown } | undefined)?.default ?? mod.default ?? mod) as AjvCtor;
}

async function doCompile(schema: JsonSchema, label: string): Promise<CompileResult> {
  const prepared = prepare(schema);
  const warnings = prepared.externalRefs.map((r) => `${label}: external $ref ${r} is not downloaded; that part is not validated`);
  let lastError: unknown;
  for (const draft of prepared.drafts) {
    try {
      const Ajv = await loadAjv(draft);
      const options = { allErrors: true, strict: false, unicodeRegExp: false, logger: false, allowUnionTypes: true };
      const plain = new Ajv({ ...options, validateFormats: false }).compile(prepared.schema);
      type Check = ((data: unknown) => boolean) & { errors?: ErrorObject[] | null };
      let withFormats: Check | undefined;
      return {
        ok: true,
        compiled: {
          warnings,
          check(data) {
            plain(data);
            return plain.errors ? [...plain.errors] : [];
          },
          async formats(data) {
            if (!withFormats) {
              const ajv = new Ajv({ ...options, validateFormats: true });
              const mod: Record<string, unknown> = await import('ajv-formats');
              const addFormats = ((mod.default as { default?: unknown } | undefined)?.default ?? mod.default ?? mod) as (a: unknown) => void;
              addFormats(ajv);
              withFormats = ajv.compile(prepared.schema) as unknown as Check;
            }
            withFormats!(data);
            return (withFormats!.errors ?? []).filter((e) => e.keyword === 'format');
          },
        },
      };
    } catch (e) {
      lastError = e;
    }
  }
  return { ok: false, reason: reasonOf(lastError), warnings };
}

function reasonOf(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const line = text.split('\n')[0]!.trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}
