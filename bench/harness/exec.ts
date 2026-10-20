// Running a command and capturing what an agent would see.
import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the program with the given arguments (the program itself is fixed by whoever builds it). */
export type Exec = (args: string[]) => Promise<ExecResult>;

/** Spawn `file` with a complete, explicit environment; stdin is closed. */
export function spawnExec(file: string, baseArgs: readonly string[], options: { cwd: string; env: Record<string, string>; timeoutMs?: number }): Exec {
  return (args) =>
    new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(file, [...baseArgs, ...args], { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (d: string) => void (stdout += d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => void (stderr += d));
      const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60_000);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
}

/**
 * Make runs comparable: the only non-deterministic parts of what the tools print are timings in
 * via's meta line and ports/paths of this machine. Timings become a typical `100ms`, ports a
 * five-digit constant and the sandbox directory a fixed prefix, so byte counts do not wobble.
 */
export function normalizeOutput(text: string, sandboxRoot: string): string {
  return text
    .replaceAll(sandboxRoot, '/tmp/via-bench')
    .replace(/(· )(\d+ms|\d+\.\ds)( ·)/g, '$1100ms$3')
    .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:40000');
}
