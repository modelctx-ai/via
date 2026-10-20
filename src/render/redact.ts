export const REDACTED = '***';

/**
 * Replace every exact occurrence of a resolved credential value with `***` (output.md, step 6).
 * JSON-escaped spellings of a secret are replaced too, so redaction also holds on `-o json` output.
 */
export function createRedactor(secrets: readonly string[]): (text: string) => string {
  const variants = new Set<string>();
  for (const s of secrets) {
    if (s.length === 0) continue;
    variants.add(s);
    variants.add(JSON.stringify(s).slice(1, -1));
  }
  const ordered = [...variants].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const secret of ordered) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return out;
  };
}

/** Redact every string (and every object key) inside a JSON-like value. */
export function redactValue(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, redact));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k), redactValue(v, redact)]));
  }
  return value;
}
