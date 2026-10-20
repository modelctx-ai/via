// Built-in subcommand names (cli.md). Kept free of imports so the router can use it cheaply;
// a test checks the list against RESERVED_COMMANDS in the catalog.

/** Built-ins that work (0.1, plus `batch` and `daemon` from 0.2). */
export const ACTIVE_COMMANDS = ['find', 'call', 'more', 'batch', 'servers', 'sync', 'doctor', 'prompt', 'daemon'] as const;

/** Reserved for 0.2: the name is taken, the command prints an explanation. */
export const FUTURE_COMMANDS = ['auth', 'trust'] as const;

export type ActiveCommand = (typeof ACTIVE_COMMANDS)[number];
export type FutureCommand = (typeof FUTURE_COMMANDS)[number];

export const ALL_COMMANDS: readonly string[] = [...ACTIVE_COMMANDS, ...FUTURE_COMMANDS, 'help'];

/** Lenient like every other input: case-insensitive, `_` equals `-`. */
export function matchBuiltin(input: string): ActiveCommand | FutureCommand | 'help' | undefined {
  const name = input.toLowerCase().replace(/_/g, '-');
  return ALL_COMMANDS.includes(name) ? (name as ActiveCommand | FutureCommand | 'help') : undefined;
}
