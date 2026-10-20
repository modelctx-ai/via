// A failure that ends the command with a printed error and an exit code (output.md, "错误").
import type { ErrorInfo } from '../render/errors';
import { ExitCode } from '../render/exit-codes';

export class CliFailure extends Error {
  constructor(readonly info: ErrorInfo) {
    super(info.message);
    this.name = 'CliFailure';
  }
}

export function fail(code: Exclude<ExitCode, 0>, message: string, next?: string, lines?: string[]): CliFailure {
  const info: ErrorInfo = { code, message };
  if (next !== undefined) info.next = next;
  if (lines !== undefined && lines.length > 0) info.lines = lines;
  return new CliFailure(info);
}

export const usageFailure = (message: string, next = 'via -h', lines?: string[]): CliFailure => fail(ExitCode.Usage, message, next, lines);
