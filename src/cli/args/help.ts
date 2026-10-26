// `-h` text and usage lines rendered from the input schema (arguments.md, "帮助").
import { extractParams } from '../../catalog/signature';
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

const TYPE_LABELS: Record<string, string> = { string: 'str', number: 'num', integer: 'num', boolean: 'bool', object: 'json', array: 'json' };

function describeType(model: SchemaModel, pos: Pos): { boolean: boolean; text: string; inlineEnum: boolean; literals: unknown[] | undefined } {
  let literals: unknown[] | undefined;
  for (const s of pos) literals ??= model.literals(s);
  const { types, known } = model.typeInfoPos(pos);
  if (literals && literals.every((v) => ['string', 'number', 'boolean'].includes(typeof v))) {
    const joined = literals.map(literalText).join('|');
    if (joined.length <= ENUM_INLINE_MAX) return { boolean: false, text: joined, inlineEnum: true, literals };
  }
  if (known && types.size > 0 && [...types].every((t) => t === 'boolean')) return { boolean: true, text: '', inlineEnum: false, literals };
  const labels = [...new Set([...types].map((t) => TYPE_LABELS[t]).filter((x): x is string => !!x))];
  return { boolean: false, text: `<${labels.length > 0 ? labels.join('|') : 'value'}>`, inlineEnum: false, literals };
}

function viewParams(model: SchemaModel): ParamView[] {
  const root = model.resolve(model.root);
  const props = model.propsOf([model.root]);
  return extractParams(root).map((info) => {
    const pos = props.get(info.name) ?? [];
    const t = describeType(model, pos);
    const types = model.typeInfoPos(pos);
    const items = model.items(pos);
    const itemTypes = model.typeInfoPos(items);
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

/** One short line: multi-line lists become `a: … · b: … · …` (the "get: … · get_comments: …" form). */
export function describeText(description: string | undefined, enumValues: readonly string[] = [], limit = DESCRIPTION_MAX): string {
  if (!description) return '';
  let lines = description
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .filter((l) => l.length > 0);
  if (lines.length > 1) lines = lines.filter((l) => !l.endsWith(':'));
  const pieces = lines.map((l) => {
    const item = l.replace(/^(\d+[.)]|[-*•])\s+/, '');
    const m = /^(\S+)\s+[-–—:]\s+(.*)$/.exec(item);
    return m && enumValues.includes(m[1]!) ? `${m[1]}: ${m[2]}` : item;
  });
  if (pieces.length === 0) return '';
  if (pieces.length === 1) return truncateChars(pieces[0]!, limit);
  let out = '';
  for (const piece of pieces) {
    const next = out ? `${out} · ${piece}` : piece;
    if (next.length > limit) {
      out = out ? `${out} · …` : truncateChars(piece, limit);
      break;
    }
    out = next;
  }
  return out;
}

/** `a, b, c, …`: whole items only, at most `max` characters before the ellipsis. */
function listWithin(items: readonly string[], max: number): string {
  let out = '';
  for (let i = 0; i < items.length; i++) {
    const next = out ? `${out}, ${items[i]}` : items[i]!;
    if (next.length > max) return out ? `${out}, …` : truncateChars(items[i]!, max);
    out = next;
  }
  return out;
}

function defaultText(v: unknown): string {
  return visibleText(typeof v === 'string' ? v : JSON.stringify(v));
}

function stringLiterals(literals: unknown[] | undefined): string[] {
  return (literals ?? []).filter((v): v is string => typeof v === 'string');
}

// Help -----------------------------------------------------------------------------------------

/** `via <provider> <resource>:<verb> -h` output (arguments.md, "帮助"). */
export function formatToolHelp(tool: McpTool, ctx: ToolArgsContext): string {
  const model = new SchemaModel(tool.inputSchema ?? {});
  const params = viewParams(model);
  const out: string[] = [formatUsage(tool, ctx), ''];

  const summary = tool.description ? truncateChars(tool.description.split(/\r?\n/).map((l) => l.trim()).find((l) => l) ?? '', 160) : '';
  if (summary) out.push(summary);

  const rows: string[][] = [];
  for (const p of params) {
    const pieces: string[] = [];
    const desc = describeText(typeof p.schema.description === 'string' ? p.schema.description : undefined, stringLiterals(p.literals));
    if (desc) pieces.push(desc);
    if (!p.inlineEnum && p.literals) pieces.push(`one of: ${listWithin(p.literals.map(literalText), 72)}`);
    if (p.scalarArray) pieces.push('repeat the flag or pass a JSON array');
    if ('default' in p.schema && p.schema.default !== undefined) pieces.push(`default: ${defaultText(p.schema.default)}`);
    // A required parameter always has its row, so `-h` answers "what does --issue-number take" even when the schema says nothing else.
    if (pieces.length === 0 && p.info.required) pieces.push(p.boolean ? 'bool' : p.placeholder);
    if (pieces.length > 0) rows.push([`  ${p.flag}`, pieces.join(' · ')]);

    // Declared fields of an object parameter: `--filter.<field>`.
    const fields = [...model.propsOf(p.pos)];
    if (fields.length > 0 && model.typeInfoPos(p.pos).types.has('object')) {
      for (const [field, schemas] of fields.slice(0, NESTED_FIELDS_MAX)) {
        const t = describeType(model, schemas);
        const fieldSchema = model.resolve(schemas[0]);
        const text: string[] = [t.boolean ? 'bool' : t.text.replace(/^<|>$/g, '')];
        const d = describeText(typeof fieldSchema.description === 'string' ? fieldSchema.description : undefined, stringLiterals(t.literals));
        if (d) text.push(d);
        if (fieldSchema.default !== undefined) text.push(`default: ${defaultText(fieldSchema.default)}`);
        rows.push([`  ${visibleText(model.displayArg([p.info.name, field]))}`, text.join(' · ')]);
      }
      if (fields.length > NESTED_FIELDS_MAX) rows.push([`  ${p.flag}.…`, `${fields.length - NESTED_FIELDS_MAX} more fields`]);
    }
  }
  out.push(...alignRows(rows, 3));

  if (model.allowsExtra([model.root])) out.push('accepts extra fields: --<name> <value>');
  const clashes = model.nameIndex([model.root]).collisions();
  for (const group of clashes) {
    out.push(`note: ${group.join(' and ')} become the same flag; pass each by its original name`);
  }

  const example = formatCallExample(tool, ctx);
  if (example) out.push(example);

  const marks = [`alias: ${shellArg(ctx.rawName, { placeholder: 'name' })}`];
  if (ctx.readOnly) marks.push('read-only');
  if (ctx.destructive) marks.push(ctx.destructiveBy === 'inferred' ? 'destructive? (inferred from the name; needs --yes)' : ctx.destructiveBy === 'config' ? 'needs --yes (confirm in the via config)' : 'destructive (needs --yes)');
  out.push(marks.join(' · '));
  return out.join('\n');
}
