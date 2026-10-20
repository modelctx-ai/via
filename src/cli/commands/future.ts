// Built-ins reserved for 0.2 (roadmap.md): the name is taken, the command explains itself.
import { ExitCode } from '../../render/exit-codes';
import type { App } from '../app';
import type { FutureCommand } from '../builtins';
import { fail } from '../failure';

const WHAT: Record<FutureCommand, string> = {
  daemon: 'via daemon (the background process; 0.1 always connects in-process)',
};

export function futureCommand(_app: App, command: FutureCommand): never {
  throw fail(ExitCode.Usage, `${WHAT[command]} is not available until 0.2`, 'see docs/roadmap.md');
}
