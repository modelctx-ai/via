// What a server says about itself, reduced to what `via <provider> -h` shows (discovery.md, "server 自述").
// Pure: the SDK client hands over its `serverInfo` and `instructions` and this cuts them to size. The text is
// the server's, so it is bounded here (the cache file stays small) and again, redacted and labeled, where
// it is printed.
import type { ServerSelf } from '../protocol';

/** Characters of `description` and `instructions` kept; the same number is what `-h` prints. */
export const SELF_TEXT_MAX = 500;

/** The first `max` code points of `text` (a surrogate pair is never cut in half), and how long it was. */
export function clipText(text: string, max = SELF_TEXT_MAX): { text: string; chars: number } {
  const points = Array.from(text);
  return { text: points.length > max ? points.slice(0, max).join('') : text, chars: points.length };
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined);

/**
 * `serverInfo` (the SDK's `Implementation`) and the `instructions` string as a `ServerSelf`. Fields the server
 * did not send are absent; a server that sent nothing gives `{}`, which is a known answer ("nothing to show").
 */
export function describeServer(info: Record<string, unknown> | undefined, instructions: string | undefined, redact: (text: string) => string = (t) => t): ServerSelf {
  const self: ServerSelf = {};
  // Redacted before it is cut: a credential the server echoed must not survive as the half the cut leaves.
  const short = (value: unknown): string | undefined => {
    const t = text(value);
    return t === undefined ? undefined : clipText(redact(t), 120).text;
  };
  const name = short(info?.name);
  if (name) self.name = name;
  const title = short(info?.title);
  if (title && title !== name) self.title = title;
  const version = short(info?.version);
  if (version) self.version = version;
  const website = short(info?.websiteUrl);
  if (website) self.websiteUrl = website;
  for (const [key, value] of [
    ['description', info?.description],
    ['instructions', instructions],
  ] as const) {
    const t = text(value);
    if (t === undefined) continue;
    const clipped = clipText(redact(t));
    self[key] = clipped.text;
    if (clipped.chars > SELF_TEXT_MAX) self[key === 'description' ? 'descriptionChars' : 'instructionsChars'] = clipped.chars;
  }
  return self;
}

/** A stored `ServerSelf` is trusted only if every field has the right type; anything else counts as not recorded. */
export function validSelf(value: unknown): ServerSelf | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const self: ServerSelf = {};
  for (const key of ['name', 'title', 'version', 'description', 'websiteUrl', 'instructions'] as const) {
    if (v[key] === undefined) continue;
    if (typeof v[key] !== 'string') return undefined;
    self[key] = v[key] as string;
  }
  for (const key of ['descriptionChars', 'instructionsChars'] as const) {
    if (v[key] === undefined) continue;
    if (typeof v[key] !== 'number' || !Number.isFinite(v[key])) return undefined;
    self[key] = v[key] as number;
  }
  return self;
}
