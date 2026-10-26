// Entry point. Kept thin on purpose: the trivial paths (`--version`, `-h`) touch nothing but
// static text. Everything else, commander-free option handling included, lives in the command
// runner, which is imported only when needed (implementation.md, "启动速度").
import * as nodeModule from 'node:module';
import { pathContext } from '../config/paths';
import { policyFiles } from '../config/policy-probe';
import { HELP, VERSION } from './help';
import { stdoutWriter } from './stdio';

const argv = process.argv.slice(2);
const first = argv[0];

let code = 0;
if (first === '--version' || first === '-V') {
  stdoutWriter().write(`${VERSION}\n`);
} else if ((first === '-h' || first === '--help') && policyFiles(pathContext(), process.cwd()).length === 0) {
  // With `commands` in a config file the help leaves commands out (ADR 0028): the runner prints it.
  stdoutWriter().write(HELP);
} else {
  try {
    // Node 22+: cache compiled code between runs. Bun exposes the function as a stub; it has its own
    // transpiler cache, so there is nothing to cache.
    if (process.versions.bun === undefined) (nodeModule as { enableCompileCache?: () => unknown }).enableCompileCache?.();
  } catch {
    // an unwritable cache directory must not stop the command
  }
  const { run } = await import('./run');
  code = await run(argv);
}
process.exitCode = code;
// Open handles (a stdio server that ignores SIGTERM) must not keep the process alive for ever.
setTimeout(() => process.exit(code), 3000).unref();
