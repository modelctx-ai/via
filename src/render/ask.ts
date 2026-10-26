// The two shapes of a `next:` that only a person can carry out (output.md, "错误"): a command that
// needs a terminal or a decision, and something to arrange (install a program, fix a credential).
// An agent that reads `ask the user…` stops and relays it, instead of running a command that cannot
// work for it.

/** `ask the user to run this in a terminal`, the lead-in shared with elicitation and `via trust`. */
export const ASK_TO_RUN = 'ask the user to run this in a terminal';

/** A command only a person can run (`via trust …`, `via auth login …`); `command` is already quoted. */
export function askToRun(command?: string): string {
  return command === undefined ? ASK_TO_RUN : `${ASK_TO_RUN}: ${command}`;
}

/** Something only a person can arrange; `text` is a sentence, with anything echoed already cleaned. */
export function askUser(text: string): string {
  return `ask the user: ${text}`;
}
