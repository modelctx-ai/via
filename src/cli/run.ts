// The command runner: global options, routing (cli.md, "解析顺序") and exit codes. Commands are
// imported on demand, so a trivial command never loads the ones it does not use. `run` takes
// everything from the outside world as parameters, which is how the tests drive it in-process.
import type { App } from './app';
import { matchBuiltin } from '../command-names';
import { makeEnv, type CliEnv } from './env';
import { CliFailure, usageFailure } from './failure';
import { COMMAND_USAGE } from './help';
import { extractGlobals, type GlobalOptions } from './options';
import { checkPolicy, loadCliPolicy, sandboxApplies } from './policy';
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
  // `commands` and `sandbox` (ADR 0027, ADR 0028) decide before anything runs: a refused command
  // starts nothing, and a sandboxed one runs again inside the sandbox instead of here.
  const policy = await loadCliPolicy(io);
  const blocked = checkPolicy(policy, rest, options);
  if (blocked) {
    io.stderr.write(formatError(blocked, options.format));
    return blocked.code;
  }
  if (sandboxApplies(policy.policy.sandbox, rest, options, io.env)) {
    try {
      return await (await import('./sandbox')).runSandboxed(io, policy.policy.sandbox, argv);
    } catch (error) {
      const info = error instanceof CliFailure ? error.info : { code: ExitCode.Internal, message: error instanceof Error ? error.message : String(error) };
      io.stderr.write(formatError(info, options.format));
      return info.code;
    }
  }
  const { App } = await import('./app');
  const app = new App(io, options, policy.policy);
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
    if (options.complete !== undefined) throw usageFailure('--complete applies to via prompts <provider> <name> and via resources <provider> <template>', 'via prompts -h');
    if (options.detach) throw usageFailure('--detach applies to a tool call, not to a listing', 'via call -h');
    if (options.schemaSnapshot !== undefined) throw usageFailure('--schema-snapshot applies to a tool call or its usage (-h), not to a listing', 'via call -h');
    if (options.help) {
      app.out(app.helpText());
      return ExitCode.Ok;
    }
    return (await import('./commands/root')).rootCommand(app);
  }

  const builtin = matchBuiltin(first);
  if (builtin !== undefined) {
    const argv = words.slice(1);
    // A check that cannot run must not look like one that passed.
    if (options.schemaSnapshot !== undefined && builtin !== 'call') {
      throw usageFailure(`--schema-snapshot applies to a tool call or its usage (-h), not to via ${builtin}`, 'via call -h');
    }
    if (options.complete !== undefined && builtin !== 'prompts' && builtin !== 'resources') {
      throw usageFailure(`--complete applies to via prompts <provider> <name> and via resources <provider> <template>, not to via ${builtin}`, 'via prompts -h');
    }
    if (options.detach && builtin !== 'call' && builtin !== 'batch') throw usageFailure(`--detach applies to a tool call, not to via ${builtin}`, 'via call -h');
    if (builtin === 'help') {
      const topic = argv[0] === undefined ? undefined : matchBuiltin(argv[0]);
      app.out(topic && topic !== 'help' ? `${COMMAND_USAGE[topic]}\n` : app.helpText());
      return ExitCode.Ok;
    }
    // `via prompts <provider> <name> -h` is the usage of that prompt, which only the command can show.
    if (options.help && !(builtin === 'prompts' && argv.length >= 2)) {
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
      case 'daemon':
        return (await import('./commands/daemon')).daemonCommand(app, argv);
      case 'auth':
        return (await import('./commands/auth')).authCommand(app, argv);
      case 'resources':
        return (await import('./commands/mcp-data')).resourcesCommand(app, argv);
      case 'read':
        return (await import('./commands/mcp-data')).readCommand(app, argv);
      case 'prompts':
        return (await import('./commands/mcp-data')).promptsCommand(app, argv);
      case 'serve':
        return (await import('./commands/serve')).serveCommand(app, argv);
      case 'skills':
        return (await import('./commands/skills')).skillsCommand(app, argv);
      case 'tasks':
        return (await import('./commands/tasks')).tasksCommand(app, argv);
    }
  }
  if (options.complete !== undefined) throw usageFailure('--complete applies to via prompts <provider> <name> and via resources <provider> <template>', 'via prompts -h');
  return (await import('./commands/provider')).providerCommand(app, words);
}
