// The one place that turns text into a word of a command line that via prints for pasting: `next:`
// hints, `-h` usage and examples, the rules of output.md "可粘贴的命令行" and security.md. Text that
// comes from a server (names, enum values, defaults, URIs) or from the user must never be able to
// start a command, expand a variable or open a quote when the line is pasted into a shell. Only
// literal words of our own go into a command unquoted.
//
// Three shells matter: POSIX shells, PowerShell and cmd.exe. A word that is plain in all of them is
// written as it is. Anything else is quoted for the platform via runs on (single quotes on POSIX;
// on Windows a form that PowerShell and cmd.exe agree on where there is one, PowerShell's single
// quotes where cmd.exe can at worst garble but not run it), or, when no quoting is safe, replaced
// by a `<placeholder>` that the person has to fill in (and that is not a valid command if pasted).

/** Characters that can only be a forgery or an accident in a command line: controls, bidi and line separators. */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

/** A word that needs no quoting in any of the three shells (ASCII; see {@link isPlain} for the rest). */
const PLAIN_ASCII = /^[A-Za-z0-9_./-][A-Za-z0-9_./:+=@-]*$/;
// Windows also takes `\` anywhere and `~` after the first character: 8.3 short names
// (`C:\Users\RUNNER~1\…`) are common in temp paths, and neither PowerShell nor cmd.exe gives a
// `~` inside a word any meaning (a leading one can expand to the home directory in PowerShell).
const PLAIN_ASCII_WINDOWS = /^[A-Za-z0-9_./\\-][A-Za-z0-9_./\\:+=@~-]*$/;
const NON_ASCII = /[^\u0000-\u007f]/;
/** Compiled on first use: Unicode property escapes are expensive to build and nearly every word is ASCII. */
let plainUnicode: RegExp | undefined;
let plainUnicodeWindows: RegExp | undefined;

function isPlain(text: string, windows: boolean): boolean {
  if (!NON_ASCII.test(text)) return (windows ? PLAIN_ASCII_WINDOWS : PLAIN_ASCII).test(text);
  // Letters and digits of any script are ordinary word characters in every shell.
  plainUnicode ??= /^[\p{L}\p{N}_./-][\p{L}\p{N}_./:+=@-]*$/u;
  plainUnicodeWindows ??= /^[\p{L}\p{N}_./\\-][\p{L}\p{N}_./\\:+=@~-]*$/u;
  return (windows ? plainUnicodeWindows : plainUnicode).test(text);
}

/**
 * `text` as one word that a POSIX shell, PowerShell or cmd.exe (per `platform`) reads back as exactly
 * `text`, with nothing expanded or executed; undefined when there is no such spelling. `''` cannot
 * be told apart from nothing in cmd.exe, so the empty word is `""` everywhere.
 */
export function shellQuote(text: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (text === '') return '""';
  if (UNPRINTABLE.test(text)) return undefined;
  const windows = platform === 'win32';
  if (isPlain(text, windows)) return text;
  if (!windows) {
    if (!text.includes("'")) return `'${text}'`;
    // `'\''` is the POSIX way to write an apostrophe; PowerShell on Linux or macOS reads it differently,
    // and anything it then reads as syntax would run. So an apostrophe is only quoted when the text
    // has nothing a shell treats as syntax.
    return /[;&|<>(){}$`]/.test(text) ? undefined : `'${text.replace(/'/g, `'\\''`)}'`;
  }
  // PowerShell reads curly quotes (U+2018 to U+201F) as quotes, which would end the string early.
  if (/[\u2018-\u201f]/.test(text)) return undefined;
  // Double quotes, when none of `$` and backtick (PowerShell), `%` (cmd.exe), `!`, `"` or a trailing
  // backslash (which would escape the closing quote) is in the text: all three shells agree.
  if (!/["$`!%]/.test(text) && !text.endsWith('\\')) return `"${text}"`;
  // PowerShell's single quotes. cmd.exe does not know them, so the text must hold nothing cmd.exe
  // treats as syntax (`& | < > ^ ( )`, `%`, `"`): it may reach the program in pieces, but cannot run.
  if (/[&|<>^()%"]/.test(text)) return undefined;
  return `'${text.replace(/'/g, "''")}'`;
}

export interface ShellWordOptions {
  /** Shown as `<placeholder>` when the text cannot be quoted. Default `value`. */
  placeholder?: string;
  /** The word is a positional argument of via: a leading `-` would make it an option, so it is not written. */
  positional?: boolean;
  platform?: NodeJS.Platform;
}

/** `text` as a word to paste, or `<placeholder>` when it cannot be written safely. */
export function shellArg(text: string, options: ShellWordOptions = {}): string {
  const placeholder = `<${options.placeholder ?? 'value'}>`;
  if (options.positional && text.startsWith('-')) return placeholder;
  return shellQuote(text, options.platform) ?? placeholder;
}

/**
 * A path in a `next:` hint: quoted when needed, `<path>` when it cannot be (a name with a line
 * break, say).
 */
export function shellWord(text: string, platform: NodeJS.Platform = process.platform): string {
  return shellArg(text, { placeholder: 'path', platform });
}

/**
 * A tool reference or a name pair (`github issue:read`, or an explicit list of words when a word may
 * itself contain a space): each word is a word of the command line. A word that cannot be quoted makes the whole reference a `<placeholder>`, since the
 * remaining words would point at something else.
 */
export function shellWords(text: string | readonly string[], options: ShellWordOptions = {}): string {
  const placeholder = `<${options.placeholder ?? 'name'}>`;
  const list = typeof text === 'string' ? text.split(/\s+/).filter(Boolean) : text;
  if (list.length === 0) return placeholder;
  const words = list.map((word) => (options.positional && word.startsWith('-') ? undefined : shellQuote(word, options.platform)));
  return words.every((word) => word !== undefined) ? words.join(' ') : placeholder;
}

/**
 * A free-text query for `via find`, which joins its words with spaces: plain words are written as
 * they are (`via find github issue read`); with any other word the whole query becomes one quoted
 * word, since quoting the pieces of `$(touch x)` separately would only be noise. `<query>` when it
 * cannot be quoted or would start with `-`.
 */
export function shellQuery(text: string, platform?: NodeJS.Platform): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words[0]!.startsWith('-')) return '<query>';
  if (words.every((word) => !word.startsWith('-') && shellQuote(word, platform) === word)) return words.join(' ');
  return shellQuote(words.join(' '), platform) ?? '<query>';
}

/**
 * Text echoed inside a message (`no such tool: \u2026`) rather than in a command: control characters and
 * line breaks, which could forge a `next:` line or move the cursor, become visible escapes.
 */
export function visibleText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, (c) => {
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

/**
 * A text that cannot be quoted for a shell but has to be shown anyway (`via trust` lists the
 * command a file would start): a double-quoted string in which everything a shell, or a person
 * reading it, could mistake for syntax is a `\uXXXX` escape. It is meant to be read, and pasted it
 * would still not run anything.
 */
export function inertText(text: string): string {
  const special = /["$`!%\\'\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2018-\u201f\u2028-\u202e\u2060-\u2069\ufeff]/;
  let out = '"';
  for (const char of text) out += special.test(char) ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : char;
  return `${out}"`;
}
