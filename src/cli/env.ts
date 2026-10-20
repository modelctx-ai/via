// Everything the runner needs from the outside world, injectable so tests never touch the real
// process, home directory or terminal.
import { homedir } from 'node:os';
import { builtin } from '../builtin';
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
  /** Ask a question on stderr and return the first line typed in reply (`via trust`). */
  ask: (question: string) => Promise<string>;
  /** Opens a URL in a browser; the default uses the platform opener (`via auth login`). */
  openUrl?: (url: string) => Promise<{ opened: boolean; reason?: string }>;
  now: () => number;
  /** How to start `via daemon run` detached: the executable and the arguments before the subcommand. */
  daemonCommand: { command: string; args: string[] };
}

/** `isatty` on demand: `node:tty` pulls in `net` and `stream`, which a browse command never needs. */
function isTerminal(fd: number): boolean {
  return builtin<typeof import('node:tty')>('node:tty').isatty(fd);
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

async function askOnTerminal(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    // At end of input readline closes without answering; that counts as an empty answer.
    const closed = new Promise<string>((resolve) => rl.once('close', () => resolve('')));
    return await Promise.race([rl.question(question), closed]);
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
    daemonCommand: { command: process.execPath, args: [process.argv[1] ?? ''] },
  };
  // Own properties of `overrides` replace the defaults (descriptors are copied so a getter stays lazy).
  Object.defineProperties(env, Object.getOwnPropertyDescriptors(overrides));
  return env;
}
