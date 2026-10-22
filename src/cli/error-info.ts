// Anything thrown while running a command, as a printable error. Apart from `App` (app.ts) so that
// the commands that report failures themselves do not import the module that holds the run's state.
import type { ErrorInfo } from '../render/errors';
import { ExitCode } from '../render/exit-codes';
import type { ToolArgsError } from './args';
import { CliFailure } from './failure';

/** Anything thrown while running a command, as a printable error. */
export async function toErrorInfo(error: unknown): Promise<ErrorInfo> {
  if (error instanceof CliFailure) return error.info;
  if (isToolArgsError(error)) return argsErrorInfo(error);
  if (error instanceof Error && error.name === 'ClientError') {
    const e = error as Error & Pick<ErrorInfo, 'next'> & { exitCode: ErrorInfo['code']; candidates?: string[] };
    const info: ErrorInfo = { code: e.exitCode, message: e.message };
    if (e.candidates && e.candidates.length > 0) info.lines = [`did you mean: ${e.candidates.join(' · ')}`];
    if (e.next) info.next = e.next;
    return info;
  }
  if (error instanceof Error && error.name === 'CredentialError') {
    const info: ErrorInfo = { code: ExitCode.Auth, message: error.message };
    const next = (error as Error & { next?: string }).next;
    if (next) info.next = next;
    return info;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: ExitCode.Internal, message: `internal error: ${message.split('\n')[0]}`, next: 'via doctor' };
}

function isToolArgsError(error: unknown): error is ToolArgsError {
  return error instanceof Error && error.name === 'ToolArgsError';
}

/**
 * Usage and validation failures (arguments.md, "报错"): the headline, the aligned argument lines
 * and the usage block come from the argument parser; `next:` only when it gives one.
 */
async function argsErrorInfo(error: ToolArgsError): Promise<ErrorInfo> {
  const { argsErrorLines } = await import('./args');
  const info: ErrorInfo = { code: ExitCode.Usage, message: error.message, lines: argsErrorLines(error) };
  if (error.next) info.next = error.next;
  if (error.details.length > 0) info.details = [...error.details];
  return info;
}
