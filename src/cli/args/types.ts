// Public types of the argument parser (arguments.md). Re-exported from ./index.ts.
import type { SchemaCompiler } from '../../schema/validate';

/** Which tool is being called, for usage lines and messages. */
export interface ToolArgsContext {
  provider: string;
  /** Canonical command-line form, e.g. `github issue:list`. */
  ref: string;
  /** The words of `ref` when one of them may contain a space (a prompt name); each is quoted for the shell. */
  refWords?: readonly string[];
  rawName: string;
  readOnly: boolean;
  destructive: boolean;
  /** Why `destructive` is true; absent means the server declared it. Only read for the wording of `-h`. */
  destructiveBy?: 'server' | 'inferred' | 'config';
}

export interface ToolArgsIO {
  readFile(path: string): Promise<string>;
  readStdin(): Promise<string>;
}

export interface ParseToolArgsOptions {
  io: ToolArgsIO;
  /** False for `--no-validate`: parse and convert, but skip schema validation. */
  validate: boolean;
  /** Replaces resolved credential values in messages with `***`. */
  redact?: (s: string) => string;
  /** Schema compiler; default: ajv in this process. The daemon backend validates in the daemon instead. */
  compile?: SchemaCompiler;
}

export interface ParsedToolArgs {
  /** The merged argument object to send upstream. */
  args: Record<string, unknown>;
  /** stderr warnings (`format` mismatches, uncompilable schema, external `$ref`), without the `warning: ` prefix. */
  warnings: string[];
  /** False when validation was skipped (`--no-validate` or an uncompilable schema): the meta line shows `unvalidated`. */
  validated: boolean;
  /** Top-level keys the tool does not declare that were written as `--name` flags; `--dry-run` lists them. */
  extraFields: string[];
}

/** One line of a validation report: `--state  must be one of: …`. */
export interface ArgIssue {
  /** Command-line spelling: `--filter.state`, `--labels[1]`. */
  arg: string;
  message: string;
}

/** Usage or validation failure; exit code 2 (arguments.md, "报错"). */
export class ToolArgsError extends Error {
  readonly exitCode = 2 as const;
  constructor(
    message: string,
    readonly issues: readonly ArgIssue[],
    /** The `usage: …` block, already formatted. */
    readonly usage: string,
    /** The `next:` command, if any. */
    readonly next?: string,
    /** Structured `details` for `-o json` (output.md, "错误"). */
    readonly details: readonly Record<string, unknown>[] = [],
  ) {
    super(message);
    this.name = 'ToolArgsError';
  }
}
