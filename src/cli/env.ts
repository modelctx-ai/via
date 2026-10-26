// Everything the runner needs from the outside world, injectable so tests never touch the real
// process, home directory or terminal.
import { homedir } from 'node:os';
import { builtin } from '../builtin';
import { decodeText } from '../platform/text';
import { selfCommand } from '../runtime';
import { stderrWriter, stdoutWriter, type Writer } from './stdio';

export type { Writer };

export interface CliEnv {
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
  stdout: Writer;
  stderr: Writer;
  /** Reads all of stdin (for `--args -` and `--body -`). */
  readStdin: () => Promise<string>;
  /** True when a person can answer a question: stdin and stderr are both terminals. */
  interactive: boolean;
  /**
   * Ask a question on stderr and return the first line typed in reply (`via trust`, a server's question during
   * a call). `signal` withdraws the question (the call ran out of time): the answer is then empty.
   */
  ask: (question: string, options?: { signal?: AbortSignal }) => Promise<string>;
  /** Opens a URL in a browser; the default uses the platform opener (`via auth login`). */
  openUrl?: (url: string) => Promise<{ opened: boolean; reason?: string }>;
  now: () => number;
  /** Ends long-running commands (`via daemon logs --follow`); default: SIGINT and SIGTERM of this process. */
  interrupt?: AbortSignal;
  /** How to start `via daemon run` detached: the executable and the arguments before the subcommand. */
  daemonCommand: { command: string; args: string[] };
  /**
   * Whether `stdout`, `stderr` and `readStdin` are this process's own, so a child (the sandbox, ADR 0027)
   * can be given them as they are. False when output is captured (`via serve`, tests).
   */
  inheritStdio?: boolean;
}

/** `isatty` on demand: `node:tty` pulls in `net` and `stream`, which a browse command never needs. */
function isTerminal(fd: number): boolean {
  return builtin<typeof import('node:tty')>('node:tty').isatty(fd);
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return decodeText(Buffer.concat(chunks));
}

/** Lines that arrived together with an answer (pasted, or typed ahead): the next question gets them. */
const typedAhead: string[] = [];

async function askOnTerminal(question: string, options: { signal?: AbortSignal } = {}): Promise<string> {
  const early = typedAhead.shift();
  if (early !== undefined) {
    process.stderr.write(`${question}${early}\n`);
    return early;
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    // The pending question takes the first line of a chunk; readline emits the rest as `line` events.
    rl.on('line', (line) => typedAhead.push(line));
    // At end of input readline closes without answering; that counts as an empty answer.
    const closed = new Promise<string>((resolve) => rl.once('close', () => resolve('')));
    return await Promise.race([rl.question(question, options.signal ? { signal: options.signal } : {}), closed]);
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') return '';
    throw error;
  } finally {
    rl.close();
  }
}

export function makeEnv(overrides: Partial<CliEnv> = {}): CliEnv {
  const env: CliEnv = {
    env: process.env,
    cwd: process.cwd(),
    home: homedir(),
    platform: process.platform,
    stdout: stdoutWriter(),
    stderr: stderrWriter(),
    readStdin: readProcessStdin,
    // A getter: only `via trust` asks, and checking costs a module load.
    get interactive(): boolean {
      return isTerminal(0) && isTerminal(2);
    },
    ask: askOnTerminal,
    now: Date.now,
    daemonCommand: selfCommand(),
    inheritStdio: overrides.stdout === undefined && overrides.stderr === undefined && overrides.readStdin === undefined,
  };
  // Own properties of `overrides` replace the defaults (descriptors are copied so a getter stays lazy).
  Object.defineProperties(env, Object.getOwnPropertyDescriptors(overrides));
  return env;
}
