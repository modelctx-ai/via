export const REDACTED = '***';

/**
 * Credentials at least this long are also matched inside text the CLI composes itself and inside
 * object keys. Shorter ones (`x`, `1`, `true`) cannot be told apart from ordinary words there, so
 * they are matched only where the data's structure is known: in string *values* (output.md, "脱敏").
 */
export const MIN_SCAN_LENGTH = 8;

type TextFn = (text: string) => string;

/**
 * A redactor is a function for string values (every credential, wherever it occurs), with two
 * stricter-scoped companions.
 */
export interface Redactor {
  /** Content: a string value of the data. Every known credential is replaced, whatever its length. */
  (text: string): string;
  /**
   * An object key. Keys are schema, not content: only credentials of {@link MIN_SCAN_LENGTH} or more
   * are looked for in them (a map keyed by an API key is plausible; a key that is the word `text` is
   * a field, whatever the credential is).
   */
  key(key: string): string;
  /**
   * Text the CLI composed (labels, `error:` lines, tables, JSON documents): only credentials of
   * {@link MIN_SCAN_LENGTH} or more are replaced. Anything short that this text carries has to be
   * redacted as a value before the text is composed.
   */
  scan(text: string): string;
}

function variantsOf(secrets: readonly string[]): string[] {
  const variants = new Set<string>();
  for (const s of secrets) {
    if (s.length === 0) continue;
    variants.add(s);
    variants.add(JSON.stringify(s).slice(1, -1));
  }
  return [...variants].sort((a, b) => b.length - a.length);
}

function replacerOf(ordered: readonly string[]): TextFn {
  if (ordered.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const secret of ordered) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return out;
  };
}

/**
 * Replace resolved credential values with `***` (output.md, step 6). JSON-escaped spellings of a
 * secret are replaced too, so redaction also holds on `-o json` output.
 */
export function createRedactor(secrets: readonly string[]): Redactor {
  const ordered = variantsOf(secrets);
  const long = ordered.filter((s) => s.length >= MIN_SCAN_LENGTH);
  const content = replacerOf(ordered);
  const scan = replacerOf(long);
  return Object.assign((text: string) => content(text), {
    scan: (text: string) => scan(text),
    key: (key: string) => scan(key),
  });
}

/** A redactor that follows a growing list of secrets (a resolver fills it while commands run). */
export function lazyRedactor(secrets: () => readonly string[]): Redactor {
  let known = -1;
  let current = createRedactor([]);
  const get = (): Redactor => {
    const now = secrets();
    // Lists only ever grow, so a changed length is the only change there can be.
    if (now.length !== known) {
      known = now.length;
      current = createRedactor(now);
    }
    return current;
  };
  return Object.assign((text: string) => get()(text), {
    scan: (text: string) => get().scan(text),
    key: (key: string) => get().key(key),
  });
}

/** The scan-strength companion of `redact`; a plain function (tests, identity) stands for itself. */
export function scannerOf(redact: TextFn): TextFn {
  return (redact as Partial<Redactor>).scan ?? redact;
}

function keyOf(redact: TextFn): TextFn {
  return (redact as Partial<Redactor>).key ?? ((key) => key);
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';

/**
 * Redact the string values of a JSON-like value. The shape is preserved: arrays keep their length,
 * objects their keys (see {@link Redactor.key}), and numbers, booleans and null stay as they are.
 */
export function redactValue(value: unknown, redact: TextFn): unknown {
  const key = keyOf(redact);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redact(v);
    if (Array.isArray(v)) return v.map(walk);
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [key(k), walk(x)]));
    return v;
  };
  return walk(value);
}

/** Protocol fields the renderer and the framing dispatch on; a credential cannot live there. */
const STRUCTURAL_FIELDS = new Set(['type', 'mimeType', 'role', 'audience', 'lastModified']);
/** Base64 payloads: they go to a file, never to the output, and replacing inside them only corrupts them. */
const BINARY_FIELDS = new Set(['data', 'blob']);
/** Servers put arbitrary data here; it is content all the way down. */
const FREE_FORM_FIELDS = new Set(['structuredContent', '_meta']);

const isPlainField = (x: unknown): boolean => typeof x === 'string' || (Array.isArray(x) && x.every((e) => typeof e === 'string'));

/**
 * Redact an MCP result as the daemon hands it out (tool results, resources, prompts). Like
 * {@link redactValue}, but the protocol's own fields stay intact: content block `type`, `mimeType`,
 * `role` and the base64 `data`/`blob` payloads; `structuredContent` and `_meta` are plain data and get
 * no such exemption. A credential in `text`, `uri`, `name`, `description` and the like is replaced.
 */
export function redactProtocol(value: unknown, redact: TextFn): unknown {
  const key = keyOf(redact);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redact(v);
    if (Array.isArray(v)) return v.map(walk);
    if (!isObject(v)) return v;
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => {
        if (isPlainField(x) && (STRUCTURAL_FIELDS.has(k) || BINARY_FIELDS.has(k))) return [key(k), x];
        return [key(k), FREE_FORM_FIELDS.has(k) ? redactValue(x, redact) : walk(x)];
      }),
    );
  };
  return walk(value);
}
