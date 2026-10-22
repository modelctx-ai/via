// Elicitation: a server asking the person behind the call for input in the middle of it (ADR 0018,
// daemon.md "elicitation"). Types and the few pure helpers every layer shares: the session (which
// receives the server's question), the daemon (which forwards it over the socket) and the CLI (which
// asks the person or declines). Nothing here loads the MCP SDK.

/** A value a form field can carry (the protocol's `ElicitResult.content` values). */
export type ElicitValue = string | number | boolean | string[];

/** The flat object schema of a form-mode question (as the server sent it, strings redacted). */
export interface ElicitSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
}

interface Asked {
  /** The provider asking, for the person to read ("github asks for your input"). */
  provider: string;
  /** The server's text. Untrusted: shown with control characters visible. */
  message: string;
  /** Milliseconds left of the call's budget; the person's time to answer counts against it. */
  timeLeftMs?: number;
}

export type FormQuestion = Asked & { mode: 'form'; requestedSchema: ElicitSchema };

export type UrlQuestion = Asked & {
  mode: 'url';
  url: string;
  /**
   * The server did not wait: it failed the call with `URLElicitationRequired` and expects the call
   * to be made again once the person has finished at the URL. The person is asked to say when.
   */
  retry?: boolean;
};

export type ElicitQuestion = FormQuestion | UrlQuestion;

export type ElicitAnswer =
  | { action: 'accept'; content?: Record<string, ElicitValue> }
  | { action: 'decline' }
  | { action: 'cancel' };

/**
 * Whoever answers a server's question on behalf of one call: the CLI process that made it (in
 * process), or the CLI at the other end of the daemon's socket. Whether a person can be asked at all
 * is the sink's business, found out only when a question arrives (looking for a terminal costs a
 * module load that no call without a question should pay); a sink that cannot ask declines and keeps
 * a note of it for the call's outcome.
 */
export interface ElicitSink {
  ask(question: ElicitQuestion): Promise<ElicitAnswer>;
}

/** The capability via declares (ADR 0018): both modes. Never `sampling`: via does not call a model. */
export const ELICITATION_CAPABILITY = { form: { applyDefaults: true }, url: {} } as const;

/** JSON-RPC code of `URLElicitationRequired` (2025-11-25). */
export const URL_ELICITATION_REQUIRED = -32042;

/** Longest answer text (a string value, or a list entry) the daemon relays to a server. */
const MAX_TEXT = 64 * 1024;

/**
 * An answer as received over the socket, or from anything else that is not this code: the shape the
 * protocol allows and nothing else (the content is relayed to the server, so it is bounded too).
 * Anything malformed is a `cancel`.
 */
export function parseAnswer(value: unknown): ElicitAnswer {
  if (typeof value !== 'object' || value === null) return { action: 'cancel' };
  const { action, content } = value as { action?: unknown; content?: unknown };
  if (action === 'decline') return { action: 'decline' };
  if (action !== 'accept') return { action: 'cancel' };
  if (content === undefined) return { action: 'accept' };
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return { action: 'cancel' };
  const out: Record<string, ElicitValue> = {};
  for (const [key, v] of Object.entries(content)) {
    if (typeof v === 'string' && v.length <= MAX_TEXT) defineValue(out, key, v);
    else if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) defineValue(out, key, v);
    else if (Array.isArray(v) && v.length <= 1000 && v.every((e) => typeof e === 'string' && e.length <= MAX_TEXT)) defineValue(out, key, [...(v as string[])]);
    else return { action: 'cancel' };
  }
  return { action: 'accept', content: out };
}

/** A key like `__proto__` must stay an ordinary property of the object that goes back to the server. */
function defineValue(target: Record<string, ElicitValue>, key: string, value: ElicitValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** A question as the protocol's parameters (`mode` optional: absent means form), or undefined when they are unusable. */
export function parseQuestion(params: unknown, provider: string): ElicitQuestion | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const p = params as Record<string, unknown>;
  const message = typeof p.message === 'string' ? p.message : '';
  if (p.mode === 'url') return typeof p.url === 'string' ? { mode: 'url', provider, message, url: p.url } : undefined;
  const schema = p.requestedSchema;
  if (typeof schema !== 'object' || schema === null) return undefined;
  const properties = (schema as { properties?: unknown }).properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return undefined;
  const required = (schema as { required?: unknown }).required;
  return {
    mode: 'form',
    provider,
    message,
    requestedSchema: {
      type: 'object',
      properties: properties as ElicitSchema['properties'],
      ...(Array.isArray(required) ? { required: required.filter((r): r is string => typeof r === 'string') } : {}),
    },
  };
}

/** What a log line may say about a question: its kind and size, never its text. */
export function describeQuestion(question: ElicitQuestion): string {
  return question.mode === 'url' ? 'url' : `form, ${Object.keys(question.requestedSchema.properties).length} field(s)`;
}

/**
 * The pages a `URLElicitationRequired` error (code -32042, `data.elicitations`) asks the person to visit,
 * or undefined when `err` is any other error. Entries that are not URL-mode questions are left out.
 */
export function urlElicitationsOf(err: unknown): Array<{ url: string; message: string }> | undefined {
  if (typeof err !== 'object' || err === null || (err as { code?: unknown }).code !== URL_ELICITATION_REQUIRED) return undefined;
  const listed = (err as { data?: { elicitations?: unknown } }).data?.elicitations;
  if (!Array.isArray(listed)) return undefined;
  const pages: Array<{ url: string; message: string }> = [];
  for (const entry of listed) {
    const { mode, url, message } = (entry ?? {}) as { mode?: unknown; url?: unknown; message?: unknown };
    if (mode === 'url' && typeof url === 'string') pages.push({ url, message: typeof message === 'string' ? message : '' });
  }
  return pages.length > 0 ? pages : undefined;
}
