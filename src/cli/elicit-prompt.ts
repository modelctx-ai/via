// Asking the person at the terminal what a server asked (ADR 0018). Loaded only when a server does
// ask and a terminal is there: it is not on the path of any other command. Everything the server
// wrote (the message, field titles, descriptions, choices, the URL) is untrusted text: it is shown
// with control characters and escape sequences as visible `\uXXXX`, never interpreted, and after the
// session redacted it. The questions are asked on stderr, the answers read from stdin.
import type { ElicitAnswer, ElicitQuestion, ElicitValue, FormQuestion, UrlQuestion } from '../client/elicit';
import { visibleText } from '../render/shell';
import type { App } from './app';
import { defaultLabel, describeFields, hintOf, readValue, type Field } from './elicit-form';

/** Tries a question gets (an empty line counts) before the whole thing is cancelled: end of input must not loop. */
const ATTEMPTS = 4;
/** Longest piece of the server's text shown in one go. */
const MAX_SHOWN = 2000;
/** Choices listed under a field; more are still accepted by number, value or title. */
const MAX_LISTED = 40;

/** The person is gone (end of input, time is up): the dialog ends with a `cancel`. */
class Gone extends Error {}

/** A server's text for the terminal: the lines of a message prefixed, every control character visible. */
export function quoted(text: string, prefix = '  | '): string {
  const clipped = text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}… (${text.length - MAX_SHOWN} more characters)` : text;
  return clipped
    .split(/\r\n|\n|\r/)
    .map((line) => `${prefix}${visibleText(line)}`)
    .join('\n');
}

/** Ask `question`; resolves with the person's answer (`cancel` when they are gone). */
export async function askPerson(app: App, question: ElicitQuestion): Promise<ElicitAnswer> {
  const dialog = new Dialog(app, question.timeLeftMs);
  try {
    return question.mode === 'url' ? await dialog.url(question) : await dialog.form(question);
  } catch (error) {
    if (!(error instanceof Gone)) throw error;
    dialog.say(`· ${error.message}; ${question.provider} was told you cancelled\n`);
    return { action: 'cancel' };
  }
}

class Dialog {
  private readonly signal: AbortSignal | undefined;

  constructor(
    private readonly app: App,
    private readonly timeLeftMs: number | undefined,
  ) {
    this.signal = timeLeftMs === undefined ? undefined : AbortSignal.timeout(Math.max(1, timeLeftMs));
  }

  say(text: string): void {
    this.app.err(this.app.redact.scan(text));
  }

  private async line(prompt: string): Promise<string> {
    if (this.signal?.aborted) throw new Gone('time is up (--timeout covers the time you take to answer)');
    const text = await this.app.io.ask(prompt, this.signal ? { signal: this.signal } : undefined);
    if (this.signal?.aborted) throw new Gone('time is up (--timeout covers the time you take to answer)');
    return text;
  }

  private header(question: FormQuestion | UrlQuestion, what: string): void {
    const seconds = this.timeLeftMs === undefined ? '' : ` You have ${Math.max(1, Math.round(this.timeLeftMs / 1000))}s (the --timeout of this call).`;
    const provider = visibleText(question.provider);
    this.say(`\n? ${provider} ${what} The text below comes from the server, not from via.${seconds}\n${quoted(question.message === '' ? '(no message)' : question.message)}\n`);
  }

  // Forms -------------------------------------------------------------------------------------

  async form(question: FormQuestion): Promise<ElicitAnswer> {
    const described = describeFields(question.requestedSchema);
    if ('unsupported' in described) {
      this.say(`· declined ${visibleText(question.provider)}'s question: ${described.unsupported}\n`);
      return { action: 'decline' };
    }
    const { fields } = described;
    this.header(question, fields.length === 0 ? 'asks you to confirm.' : `asks for your input (${fields.length} ${fields.length === 1 ? 'field' : 'fields'}; an empty answer takes the default shown in brackets).`);
    const content: Record<string, ElicitValue> = {};
    for (const [index, field] of fields.entries()) {
      const value = await this.field(field, index + 1, fields.length);
      if (value !== undefined) Object.defineProperty(content, field.name, { value, enumerable: true, writable: true, configurable: true });
    }
    const shown = fields.filter((f) => content[f.name] !== undefined);
    if (shown.length > 0) this.say(`\nanswers for ${visibleText(question.provider)}:\n${shown.map((f) => `  ${visibleText(f.name)}: ${visibleText(display(content[f.name]!))}`).join('\n')}\n`);
    const decision = await this.decide(`Send ${shown.length > 0 ? 'these answers' : 'your confirmation'} to ${visibleText(question.provider)}? [y]es / [n]o (decline) / [c]ancel: `);
    return decision === 'accept' ? { action: 'accept', content } : { action: decision };
  }

  private async field(field: Field, index: number, total: number): Promise<ElicitValue | undefined> {
    if (field.description) this.say(`${quoted(field.description, '    ')}\n`);
    if (field.choices) {
      const listed = field.choices.slice(0, MAX_LISTED);
      this.say(`${listed.map((c, i) => `    ${i + 1}) ${visibleText(c.value)}${c.title !== c.value ? ` (${visibleText(c.title)})` : ''}`).join('\n')}${field.choices.length > MAX_LISTED ? `\n    … ${field.choices.length - MAX_LISTED} more (type a value)` : ''}\n`);
    }
    const name = visibleText(field.name);
    const label = visibleText(field.label);
    const fallback = defaultLabel(field);
    const prompt = `${index}/${total} ${label}${label !== name ? ` (${name})` : ''} - ${hintOf(field)}${field.required ? ', required' : ''}${fallback !== undefined ? ` [${visibleText(fallback)}]` : ''}: `;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const read = readValue(field, await this.line(prompt));
      if (read.ok) return read.value;
      this.say(`  ! ${read.error}\n`);
    }
    throw new Gone('no valid answer');
  }

  /** accept / decline / cancel: no default, so an empty line or a closed input is never taken for a yes. */
  private async decide(prompt: string): Promise<'accept' | 'decline' | 'cancel'> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const word = (await this.line(prompt)).trim().toLowerCase();
      if (word === 'y' || word === 'yes') return 'accept';
      if (word === 'n' || word === 'no' || word === 'd' || word === 'decline') return 'decline';
      if (word === 'c' || word === 'cancel') return 'cancel';
      this.say('  ! answer y, n or c\n');
    }
    throw new Gone('no answer');
  }

  // URLs --------------------------------------------------------------------------------------

  async url(question: UrlQuestion): Promise<ElicitAnswer> {
    const provider = visibleText(question.provider);
    let parsed: URL;
    try {
      parsed = new URL(question.url);
    } catch {
      this.say(`· declined ${provider}'s request: the address is not a URL\n`);
      return { action: 'decline' };
    }
    // Only web pages are opened (auth.md); an address with a login in it is how links are disguised.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      this.say(`· declined ${provider}'s request: ${visibleText(parsed.protocol)} addresses are never opened, only http(s)\n`);
      return { action: 'decline' };
    }
    if (parsed.username !== '' || parsed.password !== '') {
      this.say(`· declined ${provider}'s request: the address contains a user name or password\n`);
      return { action: 'decline' };
    }
    this.header(question, 'asks you to open a web page to continue.');
    this.say(`  url:  ${visibleText(question.url)}\n  host: ${visibleText(parsed.hostname)}\n`);
    const decision = await this.decide(`Open it in your browser? [y]es / [n]o (decline) / [c]ancel: `);
    if (decision !== 'accept') return { action: decision };
    const { app } = this;
    const opened = app.io.openUrl ? await app.io.openUrl(question.url) : await (await import('../client/oauth/opener')).openBrowser(question.url, app.io.env, app.io.platform);
    this.say(opened.opened ? `· opened in your browser; finish there${question.retry ? '' : `, ${provider} continues when you are done`}\n` : `· could not open a browser${opened.reason ? ` (${visibleText(opened.reason)})` : ''}; open the address above yourself\n`);
    if (question.retry) {
      // The server did not wait: the call is made again once the person says the page is done.
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const word = (await this.line('Press Enter when you have finished there, or c to cancel: ')).trim().toLowerCase();
        if (word === '') return { action: 'accept' };
        if (word === 'c' || word === 'cancel') return { action: 'cancel' };
      }
    }
    return { action: 'accept' };
  }
}

/** A value as the summary shows it. */
function display(value: ElicitValue): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}
