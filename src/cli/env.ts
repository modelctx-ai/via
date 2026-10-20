// Everything the runner needs from the outside world, injectable so tests never touch the real
// process, home directory or terminal.
import { homedir } from 'node:os';
import { isatty } from 'node:tty';

export interface Writer {
  write(chunk: string): unknown;
}

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
  return {
    env: process.env,
    cwd: process.cwd(),
    home: homedir(),
    platform: process.platform,
    stdout: process.stdout,
    stderr: process.stderr,
    readStdin: readProcessStdin,
    interactive: isatty(0) && isatty(2),
    ask: askOnTerminal,
    now: Date.now,
    ...overrides,
  };
}
