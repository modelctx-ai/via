// Interactive login belongs to the preflight, not to a task. A model command that starts one,
// or that points a tool at some server other than this run's replay servers, is refused before
// it can open a browser.
import type { CliProgram } from './prompts';

const HTTP_URL = /^https?:\/\/\S+$/i;

/**
 * A URL that selects which MCP server to connect to, not a tool argument.
 * `--url https://docs.acme.test/` is the task's own data and must be allowed.
 */
function connectionTarget(program: CliProgram, words: readonly string[]): string | undefined {
  const flags = program === 'mcp2cli' ? ['--mcp', '--spec', '--graphql', '--base-url'] : [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    for (const flag of flags) {
      if (word === flag) return words[i + 1];
      if (word.startsWith(`${flag}=`)) return word.slice(flag.length + 1);
    }
  }
  if (program === 'mcpc' && words[1] === 'connect') return words[2];
  return undefined;
}

/** Why `words` (the full command line, program included) must not run, if it must not. */
export function rejectAuthCommand(program: CliProgram, words: readonly string[], replayUrls: readonly string[]): string | undefined {
  if (program === 'via' && words[1] === 'auth') {
    return 'error: authentication is checked before the run and cannot be started from a task (`via auth`)';
  }
  if (program === 'mcp2cli' && words.some((word) => word === '--oauth' || word.startsWith('--oauth-'))) {
    return 'error: authentication is checked before the run and cannot be started from a task (`--oauth`)';
  }
  if (program === 'mcpc' && (words[1] === 'login' || words[1] === 'logout')) {
    return `error: authentication is checked before the run and cannot be started from a task (\`mcpc ${words[1]}\`)`;
  }
  const target = connectionTarget(program, words);
  if (target === undefined || !HTTP_URL.test(target)) return undefined;
  let origin: string;
  try {
    origin = new URL(target).origin;
  } catch {
    return `error: \`${target}\` is not a replay server for this run`;
  }
  const allowed = new Set(replayUrls.map((url) => new URL(url).origin));
  if (!allowed.has(origin)) return `error: \`${target}\` is not a replay server for this run; do not call another server`;
  return undefined;
}
