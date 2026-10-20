import { MemoryCursorStore, MemoryMediaSink, renderOptions, renderToolResult, type RenderContext, type RenderOptions, type RenderOutput, type ToolResult } from '../../src/render';

/** A made-up credential. Tests assert it never reaches output; it must never appear in a snapshot. */
export const FAKE_SECRET = 'fake-credential-value-0123456789';

export function sequentialIds(): (length: number) => string {
  let n = 0;
  return (length) => (0xc7f2 + n++).toString(16).padStart(length, '0').slice(0, length);
}

export function makeContext(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    ref: 'github issue:list',
    elapsedMs: 318,
    media: new MemoryMediaSink(),
    cursors: new MemoryCursorStore({ generateId: sequentialIds() }),
    ...overrides,
  };
}

export async function render(
  result: ToolResult,
  options: Partial<RenderOptions> = {},
  ctx: Partial<RenderContext> = {},
): Promise<RenderOutput> {
  return renderToolResult(result, renderOptions(options), makeContext(ctx));
}

/** stdout then stderr, labelled, for readable file snapshots. */
export function transcript(out: RenderOutput): string {
  const parts = [`--- stdout (exit ${out.exitCode}) ---\n${out.stdout}`, `--- stderr ---\n${out.stderr}`];
  return parts.join('');
}

export const structured = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
export const jsonText = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
export const plainText = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
