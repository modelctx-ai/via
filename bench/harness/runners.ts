// Running the real programs under test: the built `via` and, when installed, `mcp2cli`. Shared by
// the token benchmark and the agent evaluation (scripts/bench-tokens.ts, scripts/bench-eval.ts).
import { spawnExec } from './exec';
import type { RunnerFactory } from './measure';

const BASE_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };

/** `mcp2cli --version` → the version, or the reason it cannot run. */
export async function probeMcp2cli(bin: string): Promise<{ version: string } | { skipped: string }> {
  try {
    const result = await spawnExec(bin, [], { cwd: process.cwd(), env: BASE_ENV, timeoutMs: 30_000 })(['--version']);
    const match = /(\d+\.\d+\.\d+\S*)/.exec(result.stdout + result.stderr);
    if (result.code === 0 && match) return { version: match[1]! };
    return { skipped: `\`${bin} --version\` failed (exit ${result.code})` };
  } catch {
    return { skipped: `\`${bin}\` not found on PATH (install: uv tool install mcp2cli==<version in bench/suite.yaml>)` };
  }
}

/** `<viaBin> --version`, run from `cwd` with a minimal environment. */
export async function viaVersion(viaBin: string, cwd: string): Promise<string> {
  return (await spawnExec(process.execPath, [viaBin], { cwd, env: BASE_ENV })(['--version'])).stdout.trim();
}

/**
 * Runners for one sandbox: `via` is `node <viaBin>`, `mcp2cli` (when given) the executable, both
 * with the sandbox's HOME and working directory. mcp2cli gets an alias per server (`bake create`),
 * a one-time setup.
 */
export function makeRunners(options: { viaBin: string; mcp2cli?: { bin: string; version: string } }): RunnerFactory {
  const { viaBin, mcp2cli } = options;
  return (sandbox) => ({
    via: spawnExec(process.execPath, [viaBin], { cwd: sandbox.project, env: sandbox.env }),
    ...(mcp2cli
      ? {
          mcp2cli: {
            exec: spawnExec(mcp2cli.bin, [], { cwd: sandbox.project, env: sandbox.env }),
            version: mcp2cli.version,
            prepare: async (urls: Readonly<Record<string, string>>) => {
              const run = spawnExec(mcp2cli.bin, [], { cwd: sandbox.project, env: sandbox.env });
              for (const [name, url] of Object.entries(urls)) {
                const result = await run(['bake', 'create', name, '--mcp', url]);
                if (result.code !== 0) throw new Error(`mcp2cli bake create ${name} failed: ${result.stderr || result.stdout}`);
              }
            },
          },
        }
      : {}),
  });
}
