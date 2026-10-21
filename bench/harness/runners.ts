// Running the real programs under test: the built `via` and, when installed, `mcp2cli` and
// `mcpc`. Shared by the token benchmark and the agent evaluation (scripts/bench-tokens.ts,
// scripts/bench-eval.ts).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** `mcpc --version` → the version, or the reason it cannot run. */
export async function probeMcpc(bin: string): Promise<{ version: string } | { skipped: string }> {
  try {
    const result = await spawnExec(bin, [], { cwd: process.cwd(), env: BASE_ENV, timeoutMs: 30_000 })(['--version']);
    const match = /(\d+\.\d+\.\d+\S*)/.exec(result.stdout + result.stderr);
    if (result.code === 0 && match) return { version: match[1]! };
    return { skipped: `\`${bin} --version\` failed (exit ${result.code}; mcpc needs Node.js 22.12 or newer)` };
  } catch {
    return { skipped: `\`${bin}\` not found on PATH (install: npm install -g @apify/mcpc@<version in bench/suite.yaml>)` };
  }
}

/** `<viaBin> --version`, run from `cwd` with a minimal environment. */
export async function viaVersion(viaBin: string, cwd: string): Promise<string> {
  return (await spawnExec(process.execPath, [viaBin], { cwd, env: BASE_ENV })(['--version'])).stdout.trim();
}

/**
 * Runners for one sandbox: `via` is `node <viaBin>`, `mcp2cli` (when given) the executable, both
 * with the sandbox's HOME and working directory. mcp2cli gets an alias per server (`bake create`),
 * a one-time setup. mcpc keeps its state (sessions, one background bridge process per session)
 * under `MCPC_HOME_DIR`, which is inside the sandbox's HOME; the servers it may connect to are
 * entries of `<project>/mcp.json`, and `cleanup` closes every session so no bridge outlives
 * its run.
 */
export function makeRunners(options: { viaBin: string; mcp2cli?: { bin: string; version: string }; mcpc?: { bin: string; version: string } }): RunnerFactory {
  const { viaBin, mcp2cli, mcpc } = options;
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
    ...(mcpc
      ? {
          mcpc: (() => {
            const env = { ...sandbox.env, MCPC_HOME_DIR: join(sandbox.home, '.mcpc') };
            const run = spawnExec(mcpc.bin, [], { cwd: sandbox.project, env });
            return {
              exec: run,
              version: mcpc.version,
              prepare: async (urls: Readonly<Record<string, string>>) => {
                mkdirSync(sandbox.project, { recursive: true });
                const mcpServers = Object.fromEntries(Object.entries(urls).map(([name, url]) => [name, { url }]));
                writeFileSync(join(sandbox.project, MCPC_CONFIG), `${JSON.stringify({ mcpServers }, null, 2)}\n`);
              },
              cleanup: () => closeMcpcSessions(run),
            };
          })(),
        }
      : {}),
  });
}

/** The server list of the mcpc column: `mcpc connect ./mcp.json:<server> @<server>`. */
export const MCPC_CONFIG = 'mcp.json';

/** Close every session so its bridge process exits; best effort, errors are ignored. */
async function closeMcpcSessions(run: ReturnType<typeof spawnExec>): Promise<void> {
  let sessions: Array<{ name: string; pid?: number }> = [];
  try {
    sessions = (JSON.parse((await run(['--json'])).stdout) as { sessions?: typeof sessions }).sessions ?? [];
  } catch {
    return;
  }
  for (const session of sessions) {
    let closed = false;
    try {
      closed = (await run(['close', session.name])).code === 0;
    } catch {
      // handled below
    }
    // Only a session that would not close is killed, so a recycled pid is never signalled.
    if (!closed && session.pid !== undefined) {
      try {
        process.kill(session.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
  }
}
