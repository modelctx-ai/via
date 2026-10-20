// The world one evaluation run happens in: replay servers armed with the task's canned results
// and, for the CLI conditions, a sandbox (isolated HOME) whose `via` and `mcp2cli` configuration
// points at those servers. Every run gets its own, so runs can go in parallel and each call log
// belongs to exactly one run.
import { cannedCalls, startReplayHttp, type ReplayLogEntry } from '../replay-server.mjs';
import type { LoadedSuite } from '../harness/load';
import type { RunnerFactory, Runners } from '../harness/measure';
import { createSandbox, type Sandbox } from '../harness/sandbox';
import type { Task } from '../harness/types';
import type { LoggedCall } from './judge';
import type { Condition } from './types';

export interface EvalEnv {
  /** Replay server URL per mounted server. */
  urls: Readonly<Record<string, string>>;
  /** Present for the CLI conditions. */
  sandbox?: Sandbox;
  runners?: Runners;
  /** Every `tools/call` the replay servers received so far, grouped by server. */
  calls(): LoggedCall[];
  /** How many of those calls no canned result answered. */
  unmatched(): number;
  close(): Promise<void>;
}

export async function createEnv(options: { loaded: LoadedSuite; task: Task; condition: Condition; runners: RunnerFactory }): Promise<EvalEnv> {
  const { loaded, task, condition } = options;
  const logs = new Map<string, ReplayLogEntry[]>();
  const closers: Array<() => Promise<void>> = [];
  const urls: Record<string, string> = {};
  let sandbox: Sandbox | undefined;
  try {
    for (const name of loaded.suite.mounted) {
      const log: ReplayLogEntry[] = [];
      const running = await startReplayHttp({ name, tools: loaded.tools.get(name)!, calls: cannedCalls([task], name, loaded.benchDir), log });
      logs.set(name, log);
      closers.push(running.close);
      urls[name] = running.url;
    }
    let runners: Runners | undefined;
    if (condition !== 'native') {
      sandbox = createSandbox(urls);
      runners = await options.runners(sandbox);
      if (condition === 'mcp2cli') {
        if (!runners.mcp2cli) throw new Error('the mcp2cli condition needs an mcp2cli runner');
        await runners.mcp2cli.prepare(urls);
      }
    }
    const owned = sandbox;
    return {
      urls,
      ...(owned ? { sandbox: owned } : {}),
      ...(runners ? { runners } : {}),
      calls: () => [...logs].flatMap(([server, log]) => log.map((entry) => ({ server, tool: entry.tool, args: entry.args, matched: entry.matched }))),
      unmatched: () => [...logs.values()].reduce((n, log) => n + log.filter((entry) => !entry.matched).length, 0),
      close: async () => {
        owned?.cleanup();
        await Promise.all(closers.map((close) => close()));
      },
    };
  } catch (error) {
    sandbox?.cleanup();
    await Promise.all(closers.map((close) => close()));
    throw error;
  }
}
