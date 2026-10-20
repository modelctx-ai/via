/** Process exit codes (output.md, "退出码"). */
export const ExitCode = {
  Ok: 0,
  ToolError: 1,
  Usage: 2,
  NotFound: 3,
  Auth: 4,
  Denied: 5,
  Upstream: 6,
  Internal: 7,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
