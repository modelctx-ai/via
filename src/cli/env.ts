// Everything the runner needs from the outside world, injectable so tests never touch the real
// process, home directory or terminal.
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

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
  /** Reads one line from stdin, undefined at end of input (`via auth login --manual`). */
  readLine: () => Promise<string | undefined>;
  /** Opens a URL in a browser; the default uses the platform opener (`via auth login`). */
  openUrl?: (url: string) => Promise<{ opened: boolean; reason?: string }>;
  now: () => number;
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

async function readProcessLine(): Promise<string | undefined> {
  const rl = createInterface({ input: process.stdin });
  return new Promise((resolve) => {
    rl.once('line', (line) => {
      resolve(line); // before close(): its 'close' event would otherwise answer "end of input" first
      rl.close();
    });
    rl.once('close', () => resolve(undefined));
  });
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
    readLine: readProcessLine,
    now: Date.now,
    ...overrides,
  };
}
