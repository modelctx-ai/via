// `commands` and `sandbox` on the command line (ADR 0027, ADR 0028): read before anything is
// dispatched, so a refused command never starts and a sandboxed one runs nothing in this process.
// Light on purpose: the YAML library and the config loader are imported only when a config file
// mentions either key (policy-probe.ts).
import { join } from 'node:path';
import type { ConfigDiagnostic } from '../config/diagnostics';
import { pathContext, userCacheDir } from '../config/paths';
import { emptyPolicy, isInternalCommand, refusedBy, SANDBOX_MARKER, type CommandPolicy, type Policy, type SandboxSettings } from '../config/policy';
import { policyFiles } from '../config/policy-probe';
import { ExitCode } from '../render/exit-codes';
import type { ErrorInfo } from '../render/errors';
import { matchBuiltin } from '../command-names';
import type { CliEnv } from './env';
import type { GlobalOptions } from './options';

export { SANDBOX_MARKER };

export interface LoadedPolicy {
  policy: Policy;
  diagnostics: ConfigDiagnostic[];
}

export async function loadCliPolicy(io: Pick<CliEnv, 'env' | 'home' | 'platform' | 'cwd'>): Promise<LoadedPolicy> {
  const ctx = pathContext({ home: io.home, env: io.env, platform: io.platform });
  const files = policyFiles(ctx, io.cwd);
  if (files.length === 0) return { policy: emptyPolicy(), diagnostics: [] };
  const { loadPolicy } = await import('../config/load');
  return loadPolicy(files, { cwd: io.cwd, env: io.env, home: io.home, platform: io.platform, parseCacheDir: join(userCacheDir(ctx), 'config') });
}

/** Commands that show configuration problems instead of stopping on them (config.md, "校验与诊断"). */
const SHOWS_DIAGNOSTICS = new Set(['doctor', 'servers', 'help']);

function refusal(policy: CommandPolicy, command: string): ErrorInfo | undefined {
  const rule = refusedBy(policy, command);
  if (rule === undefined) return undefined;
  const why = rule === 'deny' ? 'is turned off in the via config (commands.deny)' : 'is not among the commands the via config allows (commands.allow)';
  return { code: ExitCode.Denied, message: `via ${command} ${why}`, next: 'via help' };
}

/**
 * Whether the command may run: `undefined` when it may, else the failure to print. `words` is the
 * command line without the global options. A refused command is exit code 5 like a `deny` rule;
 * an error in the `commands` or `sandbox` fields stops every command but the ones that show it.
 */
export function checkPolicy(loaded: LoadedPolicy, words: readonly string[], options: GlobalOptions): ErrorInfo | undefined {
  const first = words[0];
  const command = first === undefined ? undefined : matchBuiltin(first);
  if (command !== undefined && !isInternalCommand(command, words.slice(1))) {
    const refused = refusal(loaded.policy.commands, command);
    if (refused) return refused;
    if (command === 'help' && words[1] !== undefined) {
      const topic = matchBuiltin(words[1]);
      if (topic !== undefined) {
        const topicRefused = refusal(loaded.policy.commands, topic);
        if (topicRefused) return topicRefused;
      }
    }
  }
  const errors = loaded.diagnostics.filter((d) => d.level === 'error');
  const showsThem = (command !== undefined && SHOWS_DIAGNOSTICS.has(command)) || (first === undefined && options.help);
  if (errors.length > 0 && !showsThem) {
    const lines = errors.map((d) => (d.file ? `${d.file}: ${d.message}` : d.message));
    return { code: ExitCode.Usage, message: `invalid configuration: ${lines[0]}`, next: 'via doctor', ...(lines.length > 1 ? { lines: lines.slice(1).map((l) => `  ${l}`) } : {}) };
  }
  return undefined;
}

/**
 * Whether this command line runs inside the sandbox (ADR 0027): it is on, this process is not
 * already the one inside, and the command is not one that runs outside it (`sandbox.exclude`,
 * `help`, the usage text of a built-in, `daemon run`).
 */
export function sandboxApplies(settings: SandboxSettings, words: readonly string[], options: GlobalOptions, env: CliEnv['env']): boolean {
  if (!settings.enabled || env[SANDBOX_MARKER] === '1') return false;
  const first = words[0];
  if (first === undefined) return !options.help;
  const command = matchBuiltin(first);
  if (command === undefined) return true;
  if (command === 'help' || isInternalCommand(command, words.slice(1)) || settings.exclude.includes(command)) return false;
  // `via <command> -h` prints a fixed text; `via prompts <provider> <name> -h` asks the server.
  return !options.help || (command === 'prompts' && words.length >= 3);
}
