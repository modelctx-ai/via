// What a server asking the person for input means for one call (ADR 0018, output.md "elicitation"):
// the sink that receives its questions, and the change to the call's outcome when none could be
// answered. Light on purpose (no MCP SDK, no readline): the terminal dialog is loaded only when a
// question arrives and a person can be asked.
import type { ElicitAnswer, ElicitQuestion, ElicitSink } from '../client/elicit';
import { formatError, type ErrorInfo } from '../render/errors';
import { ExitCode } from '../render/exit-codes';
import { visibleText } from '../render/shell';
import type { App } from './app';

/** A question that was declined because nobody could be asked. */
interface Unanswered {
  provider: string;
  /** What the server said, one line, redacted and with control characters visible. */
  message: string;
}

/** What the part of a call that reports to the user needs: the stderr text and the exit code so far. */
export interface Outcome {
  exitCode: number;
  stderr: string;
  error?: ErrorInfo;
}

export interface ElicitOptions {
  /**
   * Whether a person can be asked: a terminal on stdin and stderr, and not `via serve` or `via batch`. Called
   * when a question arrives and not before (finding out loads `node:tty`, which a call without a question
   * must not pay for).
   */
  interactive: () => boolean;
  /** The command a person could run themselves to answer, as pasteable words (output.md "可粘贴的命令行"). */
  rerun?: string;
}

/** One call's dealings with the questions its server asks. */
export class Elicitation {
  readonly sink: ElicitSink;
  private readonly unanswered: Unanswered[] = [];

  constructor(
    private readonly app: App,
    private readonly options: ElicitOptions,
  ) {
    this.sink = { ask: (question) => this.ask(question) };
  }

  private async ask(question: ElicitQuestion): Promise<ElicitAnswer> {
    if (!this.options.interactive()) {
      this.unanswered.push({ provider: question.provider, message: oneLine(question.message) });
      return { action: 'decline' };
    }
    return (await import('./elicit-prompt')).askPerson(this.app, question);
  }

  /**
   * The outcome of the call, told that the server asked something nobody could answer. A call that
   * succeeded anyway stays a success with a warning; one that failed with the server's own error
   * (exit code 1) becomes a refusal that needs a person (exit code 5, like `via trust` without a
   * terminal); any other failure (transport, timeout, …) keeps its code and gets the warning.
   */
  async apply<T extends Outcome>(outcome: T): Promise<T> {
    const first = this.unanswered[0];
    if (!first) return outcome;
    const { app } = this;
    const asked = this.unanswered.length === 1 ? 'asked for user input' : `asked for user input ${this.unanswered.length} times`;
    const about = first.message === '' ? '' : ` ("${first.message}")`;
    const next = `ask the user to run this in a terminal${this.options.rerun ? `: ${this.options.rerun}` : ''}`;
    if (outcome.exitCode !== ExitCode.ToolError) {
      const lines = `warning: ${first.provider} ${asked}${about} and it was declined: no terminal is attached\nnext: ${next}\n`;
      return { ...outcome, stderr: await app.redactText(lines) + outcome.stderr };
    }
    const info: ErrorInfo = {
      code: ExitCode.Denied,
      message: `${first.provider} ${asked}${about} and no terminal was available to answer`,
      next,
      ...(outcome.error?.message ? { lines: [`the server then said: ${oneLine(outcome.error.message)}`] } : {}),
    };
    return { ...outcome, exitCode: ExitCode.Denied, stderr: await app.redactText(formatError(info, app.options.format, app.redact)), error: info };
  }
}

/** The server's text as one line of at most 120 characters: nothing in it can start a `next:` line or move the cursor. */
function oneLine(text: string): string {
  const flat = visibleText(text.replace(/\s+/g, ' ').trim());
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}
