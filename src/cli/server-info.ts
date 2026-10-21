// `via <provider> -h`: what the server says about itself (discovery.md, "server 自述"). The text is the
// server's, so the block is labeled as such, redacted, stripped of anything that could move the cursor
// or forge a line, indented (nothing of it starts a line at column 0, where `next:`, `error:` and `·` live)
// and cut to about 500 characters. It appears nowhere else: not in the provider view, not in `via find`.
import type { ServerSelf } from '../protocol';
import { SELF_TEXT_MAX } from '../client/server-info';
import { visibleBlock } from '../render/shell';

export const SELF_HEADER = "from the server (its own text, not via's):";

/** The block's lines; `redact` is applied to each piece of server text before it is escaped. */
export function selfLines(self: ServerSelf, redact: (text: string) => string): string[] {
  const clean = (text: string): string => visibleBlock(redact(text));
  const lines: string[] = [];
  const name = [self.title ?? self.name, self.version].filter((p): p is string => p !== undefined).join(' ');
  if (name) lines.push(`  name: ${clean(name).replace(/\n/g, ' ')}`);
  const block = (label: string, text: string, chars: number | undefined): void => {
    const body = clean(text).replace(/\s+$/, '').split('\n');
    if (body.length === 1) lines.push(`  ${label}: ${body[0]}`);
    else lines.push(`  ${label}:`, ...body.map((l) => `    ${l}`.replace(/\s+$/, '')));
    if (chars !== undefined) lines.push(`  (${label} cut at ${SELF_TEXT_MAX} of ${chars} characters)`);
  };
  if (self.description) block('description', self.description, self.descriptionChars);
  if (self.websiteUrl) lines.push(`  website: ${clean(self.websiteUrl).replace(/\n/g, ' ')}`);
  if (self.instructions) block('instructions', self.instructions, self.instructionsChars);
  if (lines.length === 0) lines.push('  (it published no description or instructions)');
  return lines;
}

/** `-o json`: the same fields, each string redacted. */
export function selfJson(provider: string, self: ServerSelf, redact: (text: string) => string): unknown {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(self)) out[key] = typeof value === 'string' ? redact(value) : value;
  return { provider, server: out };
}
