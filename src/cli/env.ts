// Everything the runner needs from the outside world, injectable so tests never touch the real
// process, home directory or terminal.
import { homedir } from 'node:os';

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
  now: () => number;
  /** How to start `via daemon run` detached: the executable and the arguments before the subcommand. */
  daemonCommand: { command: string; args: string[] };
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
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
    now: Date.now,
    daemonCommand: { command: process.execPath, args: [process.argv[1] ?? ''] },
    ...overrides,
  };
}
