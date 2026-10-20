// Built-ins reserved for 0.2 (roadmap.md): the name is taken, the command explains itself.
import { ExitCode } from '../../render/exit-codes';
import type { App } from '../app';
import type { FutureCommand } from '../builtins';
import { fail } from '../failure';

const WHAT: Record<FutureCommand, string> = {
  auth: 'via auth (OAuth login, status, logout)',
  daemon: 'via daemon (the background process; 0.1 always connects in-process)',
};

export function futureCommand(_app: App, command: FutureCommand): never {
  const lines: string[] = [];
  let next = 'see docs/roadmap.md';
  if (command === 'auth') {
    lines.push('0.1 does not support OAuth: use a bearer token or API key, for example servers.<name>.auth: { bearer: "env:NAME" }');
    next = 'see docs/spec/auth.md';
  }
  throw fail(ExitCode.Usage, `${WHAT[command]} is not available until 0.2`, next, lines);
}
