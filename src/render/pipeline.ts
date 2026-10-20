import { cleanValue } from './clean';
import { CURSOR_TTL_MS, linesBytes, splitLongLines, takePage, type CursorRecord, type CursorStore } from './cursor';
import { ExitCode } from './exit-codes';
import { formatError, type ErrorInfo } from './errors';
import { formatMetaLine, type MetaInfo } from './meta';
import type { MediaSink } from './media';
import { createRedactor, redactValue } from './redact';
import { defaultColumns, defaultNoise, type ColumnsData, type NoiseRules } from './rules';
import { shapeValue } from './shape';
import type { ContentBlock, OutputFormat, ToolResult } from './types';

/** Default output budget in bytes (output.md, step 4). */
export const DEFAULT_BUDGET = 8192;
/** Default table cell width in characters. */
export const DEFAULT_CELL_WIDTH = 80;

export interface RenderOptions {
  format: OutputFormat;
  /** `--full`: no cell truncation and no budget. */
  full: boolean;
  /** Output budget in bytes. */
  budget: number;
  cellWidth: number;
  noise: NoiseRules;
  columns: ColumnsData;
  /** Resolved credential values that must never reach the output. */
  secrets: readonly string[];
}

export function renderOptions(overrides: Partial<RenderOptions> = {}): RenderOptions {
  return {
    format: 'text',
    full: false,
    budget: DEFAULT_BUDGET,
    cellWidth: DEFAULT_CELL_WIDTH,
    noise: defaultNoise(),
    columns: defaultColumns(),
    secrets: [],
    ...overrides,
  };
}

export interface RenderContext {
  /** Canonical tool reference for the meta line. */
  ref: string;
  elapsedMs: number;
  media: MediaSink;
  cursors: CursorStore;
  now?: () => number;
  /** Markers for the meta line, e.g. `unvalidated`. */
  flags?: string[];
  /** Warnings to print before the meta line (e.g. `outputSchema` mismatch). */
  warnings?: string[];
}

export interface RenderOutput {
  /** Data, for stdout. Empty when there is nothing to show. */
  stdout: string;
  /** Warnings and the meta line on success; the error report on failure. For stderr. */
  stderr: string;
  exitCode: ExitCode;
}

// Source selection ------------------------------------------------------------

type Piece =
  | { kind: 'value'; value: unknown }
  | { kind: 'text'; text: string }
  | { kind: 'media'; type: string; path?: string; uri?: string };

function parseJson(text: string): unknown {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

function blockPieces(block: ContentBlock, media: MediaSink): Piece[] {
  switch (block.type) {
    case 'text': {
      const parsed = parseJson(block.text);
      return [parsed !== undefined ? { kind: 'value', value: parsed } : { kind: 'text', text: block.text }];
    }
    case 'image':
    case 'audio':
      return [{ kind: 'media', type: block.type, path: media.save({ data: block.data, mimeType: block.mimeType }) }];
    case 'resource_link':
      return [{ kind: 'media', type: 'resource_link', uri: block.uri }];
    case 'resource': {
      const r = block.resource;
      if (r.text !== undefined) {
        const parsed = parseJson(r.text);
        return [parsed !== undefined ? { kind: 'value', value: parsed } : { kind: 'text', text: r.text }];
      }
      if (r.blob !== undefined) {
        return [{ kind: 'media', type: 'resource', path: media.save({ data: r.blob, mimeType: r.mimeType ?? 'application/octet-stream' }) }];
      }
      return [{ kind: 'media', type: 'resource', uri: r.uri }];
    }
  }
}

/**
 * structuredContent first, then text parsed as JSON, then the text itself. Text that merely
 * duplicates structuredContent as JSON is dropped; other blocks render in order (output.md, step 1).
 */
function selectPieces(result: ToolResult, media: MediaSink): Piece[] {
  const pieces: Piece[] = [];
  const structured = result.structuredContent !== undefined && result.structuredContent !== null;
  if (structured) pieces.push({ kind: 'value', value: result.structuredContent });
  for (const block of result.content ?? []) {
    for (const piece of blockPieces(block, media)) {
      if (structured && piece.kind === 'value') continue;
      pieces.push(piece);
    }
  }
  return pieces;
}

// Output assembly ---------------------------------------------------------------

interface Body {
  lines: string[];
  header: string[];
  rows?: number;
  hiddenColumns: number;
}

function textBody(pieces: Piece[], options: RenderOptions, redact: (s: string) => string): Body {
  // `compact` sections (one line of text or a media path) sit together; structured ones get a blank line around them.
  const sections: Array<{ lines: string[]; compact: boolean }> = [];
  let header: string[] = [];
  let rows: number | undefined;
  let hidden = 0;
  for (const piece of pieces) {
    if (piece.kind === 'value') {
      const cleaned = cleanValue(redactValue(piece.value, redact), options.noise);
      if (cleaned === undefined) continue;
      const shaped = shapeValue(cleaned, {
        cellWidth: options.full ? undefined : options.cellWidth,
        columns: options.columns,
      });
      sections.push({ lines: shaped.lines, compact: false });
      header = shaped.kind === 'table' ? shaped.header : [];
      rows = shaped.rows;
      hidden += shaped.hiddenColumns;
    } else if (piece.kind === 'text') {
      const text = redact(piece.text).replace(/\s+$/, '');
      if (text) sections.push({ lines: text.split('\n'), compact: !text.includes('\n') });
    } else {
      sections.push({ lines: [piece.path ?? piece.uri ?? ''], compact: true });
    }
  }
  const single = sections.length === 1;
  return {
    lines: sections.flatMap((s, i) =>
      i === 0 || (s.compact && sections[i - 1]!.compact) ? s.lines : ['', ...s.lines],
    ),
    header: single ? header : [],
    rows: single ? rows : undefined,
    hiddenColumns: hidden,
  };
}

function jsonBody(pieces: Piece[], options: RenderOptions, redact: (s: string) => string): Body {
  const values: unknown[] = [];
  for (const piece of pieces) {
    if (piece.kind === 'value') {
      const cleaned = cleanValue(redactValue(piece.value, redact), options.noise);
      if (cleaned !== undefined) values.push(cleaned);
    } else if (piece.kind === 'text') {
      values.push(redact(piece.text));
    } else {
      values.push(piece.path !== undefined ? { type: piece.type, path: piece.path } : { type: piece.type, uri: piece.uri });
    }
  }
  if (values.length === 0) return { lines: [], header: [], hiddenColumns: 0 };
  const value = values.length === 1 ? values[0] : values;
  return {
    lines: JSON.stringify(value, null, 2).split('\n'),
    header: [],
    rows: Array.isArray(value) ? value.length : undefined,
    hiddenColumns: 0,
  };
}

/** `-o raw`: the upstream content verbatim (text blocks as written), only redacted. */
function rawText(result: ToolResult, media: MediaSink, redact: (s: string) => string): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'resource' && block.resource.text !== undefined) parts.push(block.resource.text);
    else {
      for (const piece of blockPieces(block, media)) {
        if (piece.kind === 'media') parts.push(piece.path ?? piece.uri ?? '');
      }
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  return redact(parts.join('\n'));
}

const withNewline = (s: string) => (s === '' || s.endsWith('\n') ? s : `${s}\n`);

function stderrFor(meta: MetaInfo, ctx: Pick<RenderContext, 'warnings'>): string {
  const warnings = (ctx.warnings ?? []).map((w) => `warning: ${w}\n`).join('');
  return `${warnings}${formatMetaLine(meta)}\n`;
}

// Public API ---------------------------------------------------------------------

/**
 * Render a `tools/call` result (output.md, "渲染流程"): select the data, clean, shape, truncate
 * to the budget with a cursor for the rest, and redact. Data goes to `stdout`; the meta line,
 * warnings and errors go to `stderr`.
 */
export async function renderToolResult(
  result: ToolResult,
  options: RenderOptions,
  ctx: RenderContext,
): Promise<RenderOutput> {
  const redact = createRedactor(options.secrets);
  const now = ctx.now ?? Date.now;

  if (result.isError) return upstreamError(result, options, ctx, redact);

  if (options.format === 'raw') {
    const text = withNewline(rawText(result, ctx.media, redact));
    const bytes = Buffer.byteLength(text, 'utf8');
    return {
      stdout: text,
      stderr: stderrFor({ ref: ctx.ref, elapsedMs: ctx.elapsedMs, bytes: { shown: bytes, total: bytes }, flags: ctx.flags }, ctx),
      exitCode: ExitCode.Ok,
    };
  }

  const pieces = selectPieces(result, ctx.media);
  const body = (options.format === 'json' ? jsonBody : textBody)(pieces, options, redact);
  const all = body.lines.map(redact);
  const header = all.slice(0, body.header.length);
  const rest = all.slice(body.header.length);
  const meta: MetaInfo = {
    ref: ctx.ref,
    elapsedMs: ctx.elapsedMs,
    rows: body.rows,
    hiddenColumns: options.format === 'text' ? body.hiddenColumns : 0,
    flags: ctx.flags,
    bytes: { shown: 0, total: 0 },
  };

  const totalBytes = linesBytes(all);
  if (options.full || totalBytes <= options.budget) {
    meta.bytes = { shown: totalBytes, total: totalBytes };
    return { stdout: all.map((l) => `${l}\n`).join(''), stderr: stderrFor(meta, ctx), exitCode: ExitCode.Ok };
  }

  // Over budget: show what fits, keep the rest behind a cursor.
  const bodyLines = splitLongLines(rest, Math.max(1, options.budget - linesBytes(header)));
  const page = takePage(header, bodyLines, 0, options.budget);
  const shown = linesBytes(header) + page.bodyBytes;
  const record: CursorRecord = {
    ref: ctx.ref,
    header,
    lines: bodyLines,
    offset: page.next,
    shownBytes: shown,
    totalBytes: linesBytes(header) + linesBytes(bodyLines),
    budget: options.budget,
    hiddenColumns: meta.hiddenColumns ?? 0,
    createdAt: now(),
  };
  meta.bytes = { shown, total: record.totalBytes };
  if (page.next < bodyLines.length) meta.next = `via more ${await ctx.cursors.put(record)}`;
  return { stdout: page.lines.map((l) => `${l}\n`).join(''), stderr: stderrFor(meta, ctx), exitCode: ExitCode.Ok };
}

/** `via more <cursor>`: continue from where the previous page stopped, same format as the first page. */
export async function renderMore(
  id: string,
  ctx: Pick<RenderContext, 'elapsedMs' | 'cursors' | 'now' | 'warnings'>,
  options: Pick<RenderOptions, 'format' | 'secrets'> = { format: 'text', secrets: [] },
): Promise<RenderOutput> {
  const redact = createRedactor(options.secrets);
  const record = await ctx.cursors.get(id);
  if (!record) {
    const info: ErrorInfo = {
      code: ExitCode.NotFound,
      message: `cursor ${id} not found or expired (cursors are kept for ${CURSOR_TTL_MS / 60000} minutes)`,
      next: 'rerun the original command',
    };
    return { stdout: '', stderr: formatError(info, options.format, redact), exitCode: ExitCode.NotFound };
  }
  const page = takePage(record.header, record.lines, record.offset, record.budget);
  const shown = record.shownBytes + page.bodyBytes;
  const meta: MetaInfo = {
    ref: record.ref,
    elapsedMs: ctx.elapsedMs,
    bytes: { shown, total: record.totalBytes },
    hiddenColumns: record.hiddenColumns,
  };
  if (page.next < record.lines.length) {
    const next: CursorRecord = { ...record, offset: page.next, shownBytes: shown, createdAt: (ctx.now ?? Date.now)() };
    meta.next = `via more ${await ctx.cursors.put(next)}`;
  }
  return {
    stdout: page.lines.map((l) => redact(l)).map((l) => `${l}\n`).join(''),
    stderr: stderrFor(meta, ctx),
    exitCode: ExitCode.Ok,
  };
}

// Errors ---------------------------------------------------------------------------

/** Strip ANSI escape sequences and control characters (except newline and tab) from upstream text. */
export function sanitizeText(text: string): string {
  return (
    text
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\u001b[@-Z\\-_]/g, '')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  );
}

function upstreamError(
  result: ToolResult,
  options: RenderOptions,
  ctx: RenderContext,
  redact: (s: string) => string,
): RenderOutput {
  const texts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === 'text') texts.push(block.text);
    else if (block.type === 'resource' && block.resource.text !== undefined) texts.push(block.resource.text);
  }
  if (texts.length === 0 && result.structuredContent !== undefined) texts.push(JSON.stringify(result.structuredContent));
  let lines = sanitizeText(redact(texts.join('\n')))
    .replace(/\s+$/, '')
    .split('\n');
  if (lines.length === 1 && lines[0] === '') lines = ['tool returned an error'];

  if (!options.full) {
    const kept = takePage([], splitLongLines(lines, options.budget), 0, options.budget);
    if (kept.next < lines.length) lines = [...kept.lines, '… (truncated; rerun with --full for the whole error)'];
  }
  const info: ErrorInfo = {
    code: ExitCode.ToolError,
    message: options.format === 'json' ? lines.join('\n') : lines[0]!,
    lines: options.format === 'json' ? undefined : lines.slice(1),
    next: `via ${ctx.ref} -h`,
  };
  return { stdout: '', stderr: formatError(info, options.format, redact), exitCode: ExitCode.ToolError };
}
