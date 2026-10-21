// Global options (cli.md, "全局选项"): recognized anywhere on the command line, except when
// written as `--p.<name>`, which belongs to the tool's arguments and is passed on untouched.
import { usageFailure } from './failure';

export type OutputFormat = 'text' | 'json' | 'raw';
export type SchemaMode = 'compatible' | 'strict';

export interface GlobalOptions {
  format: OutputFormat;
  full: boolean;
  all: boolean;
  yes: boolean;
  dryRun: boolean;
  noValidate: boolean;
  /** `--timeout`, converted to milliseconds. */
  timeoutMs?: number;
  help: boolean;
  /** `--schema-snapshot <file>`: compare the tool's schemas with this snapshot before calling it or showing its usage. */
  schemaSnapshot?: string;
  /** `--schema-mode`: how strictly (arguments.md, "schema 快照校验"). */
  schemaMode: SchemaMode;
}

export function defaultOptions(): GlobalOptions {
  return { format: 'text', full: false, all: false, yes: false, dryRun: false, noValidate: false, help: false, schemaMode: 'compatible' };
}

const FLAGS: Record<string, keyof Pick<GlobalOptions, 'full' | 'all' | 'yes' | 'dryRun' | 'noValidate' | 'help'>> = {
  '--full': 'full',
  '--all': 'all',
  '--yes': 'yes',
  '--dry-run': 'dryRun',
  '--no-validate': 'noValidate',
  '-h': 'help',
  '--help': 'help',
};

function parseFormat(value: string): OutputFormat {
  if (value === 'text' || value === 'json' || value === 'raw') return value;
  throw usageFailure(`-o must be text, json or raw (got ${JSON.stringify(value.slice(0, 40))})`);
}

function parseSchemaMode(value: string): SchemaMode {
  if (value === 'compatible' || value === 'strict') return value;
  throw usageFailure(`--schema-mode must be compatible or strict (got ${JSON.stringify(value.slice(0, 40))})`);
}

function parseTimeout(value: string): number {
  const seconds = Number(value);
  if (value.trim() === '' || !Number.isFinite(seconds) || seconds <= 0) {
    throw usageFailure(`--timeout must be a positive number of seconds (got ${JSON.stringify(value.slice(0, 40))})`);
  }
  return Math.round(seconds * 1000);
}

/** Pull the global options out of `argv`; what is left keeps its order. Throws CliFailure on a bad value. */
export function extractGlobals(argv: readonly string[]): { options: GlobalOptions; rest: string[] } {
  const options = defaultOptions();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token.startsWith('--p.')) {
      rest.push(token);
      continue;
    }
    const flag = FLAGS[token];
    if (flag) {
      options[flag] = true;
      continue;
    }
    if (token === '--schema-snapshot' || token === '--schema-mode') {
      const value = argv[i + 1];
      if (value === undefined) throw usageFailure(`${token} needs a value`);
      i += 1;
      if (token === '--schema-mode') options.schemaMode = parseSchemaMode(value);
      else options.schemaSnapshot = value;
      continue;
    }
    if (token.startsWith('--schema-snapshot=')) {
      options.schemaSnapshot = token.slice('--schema-snapshot='.length);
      continue;
    }
    if (token.startsWith('--schema-mode=')) {
      options.schemaMode = parseSchemaMode(token.slice('--schema-mode='.length));
      continue;
    }
    if (token === '-o' || token === '--timeout') {
      const value = argv[i + 1];
      if (value === undefined) throw usageFailure(`${token} needs a value`);
      i += 1;
      if (token === '-o') options.format = parseFormat(value);
      else options.timeoutMs = parseTimeout(value);
      continue;
    }
    if (token.startsWith('-o=')) {
      options.format = parseFormat(token.slice(3));
      continue;
    }
    if (token.startsWith('--timeout=')) {
      options.timeoutMs = parseTimeout(token.slice('--timeout='.length));
      continue;
    }
    rest.push(token);
  }
  return { options, rest };
}

export interface LocalFlag {
  name: string;
  /** Takes a value (`--out AGENTS.md`, `--out=AGENTS.md`). */
  value: boolean;
  short?: string;
}

/**
 * Tiny parser for the fixed subcommands (`find`, `servers`, `prompt`): declared flags plus
 * positionals. Unknown flags are usage errors.
 */
export function parseLocal(
  command: string,
  argv: readonly string[],
  flags: readonly LocalFlag[],
): { flags: Record<string, string | true>; positionals: string[] } {
  const found: Record<string, string | true> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const key = eq > 0 ? token.slice(0, eq) : token;
    const def = flags.find((f) => key === `--${f.name}` || (f.short !== undefined && key === `-${f.short}`));
    if (!def) throw usageFailure(`via ${command}: unknown option ${key}`, `via ${command} -h`);
    if (!def.value) {
      found[def.name] = true;
      continue;
    }
    let value: string | undefined;
    if (eq > 0) value = token.slice(eq + 1);
    else {
      value = argv[i + 1];
      i += 1;
    }
    if (value === undefined) throw usageFailure(`via ${command}: ${key} needs a value`, `via ${command} -h`);
    found[def.name] = value;
  }
  return { flags: found, positionals };
}
