// Output validation (arguments.md, "输出校验"): outputSchema vs structuredContent, warnings only.
import type { McpTool } from '../../catalog/types';
import { type Segment, segmentsOf } from './report';
import { compileSchema } from './validate';

const MAX_WARNINGS = 3;

/**
 * Check `structuredContent` against `outputSchema`. Returns warning lines (without the
 * `warning: ` prefix); never throws. Values are not quoted: results may contain secrets.
 */
export async function validateOutput(tool: McpTool, structured: unknown): Promise<string[]> {
  try {
    if (!tool.outputSchema || structured === undefined) return [];
    const result = await compileSchema(tool.outputSchema, `${tool.name} outputSchema`);
    if (!result.ok) return [];
    const errors = result.compiled.check(structured);
    if (errors.length === 0) return [];
    const lines: string[] = [];
    for (const e of errors) {
      if (e.keyword === 'if') continue;
      const where = location(segmentsOf(structured, e.instancePath));
      const what = describe(e.keyword, e.params as Record<string, unknown>, e.message);
      const line = `${tool.name} result does not match its outputSchema: ${where} ${what}`;
      if (!lines.includes(line)) lines.push(line);
    }
    if (lines.length <= MAX_WARNINGS) return lines;
    return [...lines.slice(0, MAX_WARNINGS), `${tool.name} result: ${lines.length - MAX_WARNINGS} more outputSchema mismatches`];
  } catch {
    return [];
  }
}

function location(segments: readonly Segment[]): string {
  if (segments.length === 0) return 'result';
  return segments.map((s, i) => (typeof s === 'number' ? `[${s}]` : i === 0 ? s : `.${s}`)).join('');
}

function describe(keyword: string, params: Record<string, unknown>, message: string | undefined): string {
  switch (keyword) {
    case 'required':
      return `is missing "${String(params.missingProperty)}"`;
    case 'type':
      return `must be ${String(params.type).replace(/,/g, ' or ')}`;
    case 'additionalProperties':
      return `has unexpected field "${String(params.additionalProperty)}"`;
    case 'enum':
      return 'must be one of the allowed values';
    default:
      return message ?? 'is invalid';
  }
}
