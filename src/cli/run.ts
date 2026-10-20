// The command runner: global options, routing (cli.md, "解析顺序") and exit codes. Commands are
// imported on demand, so a trivial command never loads the ones it does not use. `run` takes
// everything from the outside world as parameters, which is how the tests drive it in-process.
import type { App } from './app';
import { matchBuiltin } from './builtins';
import { makeEnv, type CliEnv } from './env';
import { CliFailure } from './failure';
import { COMMAND_USAGE, HELP } from './help';
import { extractGlobals, type GlobalOptions } from './options';
import { formatError } from '../render/errors';
import { ExitCode } from '../render/exit-codes';

export async function run(argv: readonly string[], overrides: Partial<CliEnv> = {}): Promise<number> {
  const io = makeEnv(overrides);
  let extracted: ReturnType<typeof extractGlobals>;
  try {
    extracted = extractGlobals(argv);
  } catch (error) {
    const info = error instanceof CliFailure ? error.info : { code: ExitCode.Usage, message: String(error) };
    io.stderr.write(formatError(info, 'text'));
    return info.code;
  }
  const { options, rest } = extracted;
  const { App } = await import('./app');
  const app = new App(io, options);
  try {
    return await dispatch(app, options, rest);
  } catch (error) {
    return await app.report(error);
  } finally {
    await app.close();
  }
}

async function dispatch(app: App, options: GlobalOptions, words: string[]): Promise<number> {
  const first = words[0];
  if (first === undefined) {
    if (options.help) {
      app.out(HELP);
      return ExitCode.Ok;
    }
    return (await import('./commands/root')).rootCommand(app);
  }

  const builtin = matchBuiltin(first);
  if (builtin !== undefined) {
    const argv = words.slice(1);
    if (builtin === 'help') {
      const topic = argv[0] === undefined ? undefined : matchBuiltin(argv[0]);
      app.out(topic && topic !== 'help' ? `${COMMAND_USAGE[topic]}\n` : HELP);
      return ExitCode.Ok;
    }
    if (options.help) {
      app.out(`${COMMAND_USAGE[builtin]}\n`);
      return ExitCode.Ok;
    }
    switch (builtin) {
      case 'find':
        return (await import('./commands/find')).findCommand(app, argv);
      case 'call':
        return (await import('./commands/provider')).callCommand(app, argv);
      case 'more':
        return (await import('./commands/more')).moreCommand(app, argv);
      case 'batch':
        return (await import('./commands/batch')).batchCommand(app, argv);
      case 'servers':
        return (await import('./commands/servers')).serversCommand(app, argv);
      case 'sync':
        return (await import('./commands/sync')).syncCommand(app, argv);
      case 'doctor':
        return (await import('./commands/doctor')).doctorCommand(app);
      case 'trust':
        return (await import('./commands/trust')).trustCommand(app, argv);
      case 'prompt':
        return (await import('./commands/prompt')).promptCommand(app, argv);
      case 'auth':
        return (await import('./commands/auth')).authCommand(app, argv);
      default:
        return (await import('./commands/future')).futureCommand(app, builtin);
    }
  }
  return (await import('./commands/provider')).providerCommand(app, words);
}
