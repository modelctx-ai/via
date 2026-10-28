// `-h` text and usage lines rendered from the input schema (arguments.md, "帮助").
import { extractParams, scalarLabel, typeLabels } from '../../catalog/signature';
import type { JsonSchema, McpTool, ParamInfo } from '../../catalog/types';
import { shellArg, shellQuote, shellWords, visibleText } from '../../render/shell';
import { alignRows, truncateChars } from '../../render/width';
import { formatCallExample } from './example';
import { type Pos, rootFlagName, SchemaModel } from './schema';
import type { ToolArgsContext } from './types';

/** A usage that fits this many columns stays on one line; longer ones wrap at WRAP_WIDTH. */
const ONE_LINE_MAX = 120;
const WRAP_WIDTH = 80;
const WRAP_INDENT = 9;
const ENUM_INLINE_MAX = 60;
const DESCRIPTION_MAX = 72;
const NESTED_FIELDS_MAX = 12;
const SUMMARY_MAX = 160;

export interface UsageOptions {
  /** Show at most this many optional parameters, then `[…]` (error messages; `-h` shows all). */
  maxOptional?: number;
}

interface ParamView {
  info: ParamInfo;
  flag: string;
  pos: Pos;
  schema: JsonSchema;
  boolean: boolean;
  placeholder: string;
  /** Allowed values, when they fit on the usage line. */
  inlineEnum: boolean;
  literals: unknown[] | undefined;
  scalarArray: boolean;
}

function literalText(v: unknown): string {
  return visibleText(typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)));
}

/** A flag as written in a usage line or a parameter row: quoted if its name holds anything a shell acts on. */
const flagText = (flag: string): string => shellQuote(flag) ?? '--<name>';

/** The items of the array at `pos`: none for a tuple, and none when the schema does not say (an `anyOf` such as `array | null` is searched). */
function itemsOfPos(model: SchemaModel, pos: Pos, depth = 0): Pos {
  if (!model.expandPos(pos).some((s) => Array.isArray(s.prefixItems))) {
    const direct = model.items(pos);
    if (direct.length > 0) return direct;
  }
  if (depth < 3) {
    for (const b of model.branches(pos)) {
      for (const option of b.options) {
        const found = itemsOfPos(model, option, depth + 1);
        if (found.length > 0) return found;
      }
    }
  }
  return [];
}

/** `str`, `num`, `bool` or `(str|num)` for a list of scalars (the signature's reading, catalog/signature.ts); undefined for the rest. */
function scalarItemLabel(model: SchemaModel, pos: Pos): string | undefined {
  const items = itemsOfPos(model, pos);
  if (items.length === 0) return undefined;
  const { types, known } = model.typeInfoPos(items);
  if (!known) return undefined;
  return scalarLabel(types);
}

function describeType(model: SchemaModel, pos: Pos): { boolean: boolean; text: string; inlineEnum: boolean; literals: unknown[] | undefined } {
  let literals: unknown[] | undefined;
  for (const s of pos) literals ??= model.literals(s);
  const { types, known } = model.typeInfoPos(pos);
  if (literals && literals.every((v) => ['string', 'number', 'boolean'].includes(typeof v))) {
    const joined = literals.map(literalText).join('|');
    if (joined.length <= ENUM_INLINE_MAX) return { boolean: false, text: joined, inlineEnum: true, literals };
  }
  if (known && types.size > 0 && [...types].every((t) => t === 'boolean')) return { boolean: true, text: '', inlineEnum: false, literals };
  if (known && [...types].filter((t) => t !== 'null').join() === 'array') {
    const item = scalarItemLabel(model, pos);
    if (item !== undefined) return { boolean: false, text: `<${item}[]>`, inlineEnum: false, literals };
  }
  const labels = typeLabels(types);
  return { boolean: false, text: `<${labels.length > 0 ? labels.join('|') : 'value'}>`, inlineEnum: false, literals };
}

function viewParams(model: SchemaModel): ParamView[] {
  const root = model.resolve(model.root);
  const props = model.propsOf([model.root]);
  return extractParams(root).map((info) => {
    const pos = props.get(info.name) ?? [];
    const t = describeType(model, pos);
    const types = model.typeInfoPos(pos);
    const itemTypes = model.typeInfoPos(itemsOfPos(model, pos));
    return {
      info,
      flag: flagText(`--${rootFlagName(info.arg)}`),
      pos,
      schema: model.resolve(pos[0]),
      boolean: t.boolean,
      placeholder: t.text,
      inlineEnum: t.inlineEnum,
      literals: t.literals,
      scalarArray:
        types.known &&
        types.types.has('array') &&
        !types.types.has('string') &&
        (!itemTypes.known || ![...itemTypes.types].some((x) => x === 'object' || x === 'array')),
    };
  });
}

function token(p: ParamView): string {
  const body = p.boolean ? p.flag : `${p.flag} ${p.placeholder}`;
  return p.info.required ? body : `[${body}]`;
}

function wrap(head: string, tokens: string[]): string {
  const oneLine = [head, ...tokens].join(' ');
  if (oneLine.length <= ONE_LINE_MAX) return oneLine;
  const lines: string[] = [];
  let line = head;
  for (const t of tokens) {
    if (line.length + 1 + t.length <= WRAP_WIDTH) line += ` ${t}`;
    else {
      lines.push(line);
      line = `${' '.repeat(WRAP_INDENT)}${t}`;
    }
  }
  lines.push(line);
  return lines.join('\n');
}

/** The `usage: …` block alone, as shown under errors. */
export function formatUsage(tool: McpTool, ctx: ToolArgsContext, options: UsageOptions = {}): string {
  const model = new SchemaModel(tool.inputSchema ?? {});
  const params = viewParams(model);
  const required = params.filter((p) => p.info.required);
  const optional = params.filter((p) => !p.info.required);
  const limit = options.maxOptional ?? Infinity;
  const tokens = [...required.map(token), ...optional.slice(0, limit).map(token)];
  if (optional.length > limit) tokens.push('[…]');
  return wrap(`usage: via ${shellWords(ctx.refWords ?? ctx.ref)}`, tokens);
}

// Descriptions ---------------------------------------------------------------------------------

/** The non-empty lines of a description, trimmed, with every control character shown as a visible escape. */
function descriptionLines(description: string): string[] {
  return description
    .split(/\r?\n/)
    .map((l) => visibleText(l.trim().replace(/\s+/g, ' ')))
    .filter((l) => l.length > 0);
}

/** A description cut to one line, and whether anything was left out. */
interface Short {
  text: string;
  cut: boolean;
}

/** One short line: multi-line lists become `a: … · b: … · …` (the "get: … · get_comments: …" form). */
function shortText(description: string | undefined, enumValues: readonly string[] = [], limit = DESCRIPTION_MAX): Short {
  if (!description) return { text: '', cut: false };
  let lines = descriptionLines(description);
  if (lines.length > 1) lines = lines.filter((l) => !l.endsWith(':'));
  const pieces = lines.map((l) => {
    const item = l.replace(/^(\d+[.)]|[-*•])\s+/, '');
    const m = /^(\S+)\s+[-–—:]\s+(.*)$/.exec(item);
    return m && enumValues.includes(m[1]!) ? `${m[1]}: ${m[2]}` : item;
  });
  if (pieces.length === 0) return { text: '', cut: false };
  if (pieces.length === 1) return { text: truncateChars(pieces[0]!, limit), cut: Array.from(pieces[0]!).length > limit };
  let out = '';
  for (const piece of pieces) {
    const next = out ? `${out} · ${piece}` : piece;
    if (next.length > limit) return { text: out ? `${out} · …` : truncateChars(piece, limit), cut: true };
    out = next;
  }
  return { text: out, cut: false };
}

/** `a, b, c, …`: whole items only, at most `max` characters before the ellipsis. */
function listWithin(items: readonly string[], max: number): Short {
  let out = '';
  for (let i = 0; i < items.length; i++) {
    const next = out ? `${out}, ${items[i]}` : items[i]!;
    if (next.length > max) return { text: out ? `${out}, …` : truncateChars(items[i]!, max), cut: true };
    out = next;
  }
  return { text: out, cut: false };
}

function defaultText(v: unknown): string {
  return visibleText(typeof v === 'string' ? v : JSON.stringify(v));
}

function stringLiterals(literals: unknown[] | undefined): string[] {
  return (literals ?? []).filter((v): v is string => typeof v === 'string');
}

/** The text of a tool description for `--full`: every line, paragraphs kept (one blank line between them), nothing cut. */
function descriptionBlock(description: string): string[] {
  const out: string[] = [];
  for (const raw of description.split(/\r?\n/)) {
    const line = visibleText(raw.replace(/\t/g, '  ').trimEnd());
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line);
  }
  while (out[out.length - 1] === '') out.pop();
  return out;
}

// Help -----------------------------------------------------------------------------------------

export interface HelpOptions {
  /** `--full`: whole descriptions and every declared field; the `full text:` line is not needed then (arguments.md, "帮助"). */
  full?: boolean;
}

/** A parameter row: the label, then the lines of its text (the first next to the label, the rest under it). */
type Row = [label: string, lines: string[]];

function layoutRows(rows: readonly Row[]): string[] {
  const flat: string[][] = [];
  for (const [label, lines] of rows) {
    if (lines.length === 0) flat.push([label]);
    else lines.forEach((line, i) => flat.push([i === 0 ? label : '', line]));
  }
  // A row with a label only (`… 3 more`) does not take part in the alignment.
  const aligned = alignRows(
    flat.filter((r) => r.length === 2),
    3,
  );
  let next = 0;
  return flat.map((r) => (r.length === 2 ? aligned[next++]! : r[0]!));
}

/** `via <provider> <resource>:<verb> -h` output (arguments.md, "帮助"). */
export function formatToolHelp(tool: McpTool, ctx: ToolArgsContext, options: HelpOptions = {}): string {
  const full = options.full === true;
  const model = new SchemaModel(tool.inputSchema ?? {});
  const params = viewParams(model);
  const out: string[] = [formatUsage(tool, ctx), ''];
  /** Something was left out of the text: the `full text:` line says how to get it. */
  let cut = false;

  if (tool.description) {
    if (full) {
      const block = descriptionBlock(tool.description);
      out.push(...block);
      // A description of several lines is set off from the parameter rows that follow it.
      if (block.length > 1 && params.length > 0) out.push('');
    } else {
      const lines = descriptionLines(tool.description);
      if (lines.length > 0) {
        out.push(truncateChars(lines[0]!, SUMMARY_MAX));
        if (lines.length > 1 || Array.from(lines[0]!).length > SUMMARY_MAX) cut = true;
      }
    }
  }

  /** The description of a parameter or field as the lines of its row. */
  const describe = (description: unknown, literals: unknown[] | undefined): string[] => {
    if (typeof description !== 'string') return [];
    if (full) return descriptionLines(description);
    const short = shortText(description, stringLiterals(literals));
    if (short.cut) cut = true;
    return short.text ? [short.text] : [];
  };

  /** Pieces after the description go on its last line (`desc · default: 3`). */
  const joinPieces = (lines: string[], pieces: string[]): string[] => {
    if (pieces.length === 0) return lines;
    if (lines.length === 0) return [pieces.join(' · ')];
    return [...lines.slice(0, -1), [lines[lines.length - 1]!, ...pieces].join(' · ')];
  };

  /** One row per declared field of an object, named by `label`; the fields beyond the limit are counted. */
  const fieldRows = (fields: Array<[string, JsonSchema[]]>, required: readonly string[], label: (name: string) => string, more: (n: number) => Row): Row[] => {
    const rows: Row[] = [];
    const shown = full ? fields : fields.slice(0, NESTED_FIELDS_MAX);
    for (const [field, schemas] of shown) {
      const t = describeType(model, schemas);
      const fieldSchema = model.resolve(schemas[0]);
      const head = [t.boolean ? 'bool' : t.text.replace(/^<|>$/g, ''), ...(required.includes(field) ? ['required'] : [])].join(' · ');
      const lines = describe(fieldSchema.description, t.literals);
      const pieces = fieldSchema.default !== undefined ? [`default: ${defaultText(fieldSchema.default)}`] : [];
      rows.push([label(field), joinPieces(lines.length > 0 ? [`${head} · ${lines[0]}`, ...lines.slice(1)] : [head], pieces)]);
    }
    if (shown.length < fields.length) {
      cut = true;
      rows.push(more(fields.length - shown.length));
    }
    return rows;
  };

  const rows: Row[] = [];
  for (const p of params) {
    const lines = describe(p.schema.description, p.literals);
    const pieces: string[] = [];
    if (!p.inlineEnum && p.literals) {
      const values = p.literals.map(literalText);
      if (full) pieces.push(`one of: ${values.join(', ')}`);
      else {
        const list = listWithin(values, 72);
        if (list.cut) cut = true;
        pieces.push(`one of: ${list.text}`);
      }
    }
    if (p.scalarArray) pieces.push('repeat the flag or pass a JSON array');
    if ('default' in p.schema && p.schema.default !== undefined) pieces.push(`default: ${defaultText(p.schema.default)}`);

    // Declared fields of an array of objects: the keys of an item, spelled as in the JSON (the whole array is JSON).
    const items = itemsOfPos(model, p.pos);
    const itemFields = [...model.propsOf(items)];
    const ofObjects = itemFields.length > 0 && model.typeInfoPos(p.pos).types.has('array') && model.typeInfoPos(items).types.has('object');
    if (ofObjects) pieces.push('JSON array of objects with keys:');

    const text = joinPieces(lines, pieces);
    // A required parameter always has its row, so `-h` answers "what does --issue-number take" even when the schema says nothing else.
    if (text.length === 0 && p.info.required) text.push(p.boolean ? 'bool' : p.placeholder);
    if (text.length > 0) rows.push([`  ${p.flag}`, text]);

    if (ofObjects) rows.push(...fieldRows(itemFields, model.requiredOf(items), (name) => `    ${visibleText(name)}`, (n) => [`    … ${n} more`, []]));

    // Declared fields of an object parameter: `--filter.<field>`.
    const fields = [...model.propsOf(p.pos)];
    if (fields.length > 0 && model.typeInfoPos(p.pos).types.has('object')) {
      rows.push(...fieldRows(fields, model.requiredOf(p.pos), (name) => `  ${visibleText(model.displayArg([p.info.name, name]))}`, (n) => [`  ${p.flag}.…`, [`${n} more fields`]]));
    }
  }
  out.push(...layoutRows(rows));

  if (model.allowsExtra([model.root])) out.push('accepts extra fields: --<name> <value>');
  const clashes = model.nameIndex([model.root]).collisions();
  for (const group of clashes) {
    out.push(`note: ${group.join(' and ')} become the same flag; pass each by its original name`);
  }

  const example = formatCallExample(tool, ctx);
  if (example) out.push(example);

  if (cut) out.push(`full text: via ${shellWords(ctx.refWords ?? ctx.ref)} -h --full`);

  // A raw name that is already the canonical one is no second spelling.
  const marks = ctx.ref === `${ctx.provider} ${ctx.rawName}` ? [] : [`alias: ${shellArg(ctx.rawName, { placeholder: 'name' })}`];
  if (ctx.readOnly) marks.push('read-only');
  if (ctx.destructive) marks.push(ctx.destructiveBy === 'inferred' ? 'destructive? (inferred from the name; needs --yes)' : ctx.destructiveBy === 'config' ? 'needs --yes (confirm in the via config)' : 'destructive (needs --yes)');
  if (marks.length > 0) out.push(marks.join(' · '));
  return out.join('\n');
}
