// Built-ins reserved for 0.2 (roadmap.md): the name is taken, the command explains itself.
import { pathContext, userDataDir } from '../../config/paths';
import { trustStorePath } from '../../config/trust';
import { ExitCode } from '../../render/exit-codes';
import type { App } from '../app';
import type { FutureCommand } from '../builtins';
import { fail } from '../failure';

const WHAT: Record<FutureCommand, string> = {
  batch: 'via batch (concurrent JSONL calls)',
  trust: 'via trust (confirming project-level configuration)',
  daemon: 'via daemon (the background process; 0.1 always connects in-process)',
};

export function futureCommand(app: App, command: FutureCommand): never {
  const lines: string[] = [];
  let next = 'see docs/roadmap.md';
  if (command === 'trust') {
    const store = trustStorePath(userDataDir(pathContext({ home: app.io.home, env: app.io.env, platform: app.io.platform })));
    lines.push(
      'project-level server definitions (stdio commands, HTTP endpoints) are recorded as trusted by file path and SHA-256 in',
      `  ${store}`,
      'until via trust exists, use the server from your user config (~/.config/via/config.yaml) instead',
    );
    next = 'see docs/spec/security.md';
  }
  throw fail(ExitCode.Usage, `${WHAT[command]} is not available until 0.2`, next, lines);
}
