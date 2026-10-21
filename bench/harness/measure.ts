// Runs the suite: replay servers for every mounted server, a sandbox, then per task the native
// calls, the scripted via session and (when available) the scripted mcp2cli session. Everything
// is measured in bytes; `estimateTokens` turns bytes into tokens at report time.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cannedCalls, replayProtocolFromEnv, startReplayHttp, type ReplayCall, type ReplayLogEntry } from '../replay-server.mjs';
import { normalizeOutput, type Exec } from './exec';
import type { LoadedSuite } from './load';
import { measureInjection, measureNativeCalls, type InjectionMeasure, type NativeMeasure } from './native';
import { createSandbox, type Sandbox } from './sandbox';
import { splitCommand } from './shell';
import { bytesOf } from './tokens';
import type { Step } from './types';

export interface StepMeasure {
  command: string;
  commandBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
  exit: number;
}

/** A CLI column (via or mcp2cli): fixed instruction text plus the scripted session. */
export interface SessionMeasure {
  /** Instruction text the agent starts with, counted once. */
  fixedBytes: number;
  /** Command text and everything printed, summed over the steps. */
  sessionBytes: number;
  steps: StepMeasure[];
}

export interface TaskMeasure {
  id: string;
  title: string;
  goal: string;
  native: NativeMeasure & { injectionBytes: number; totalBytes: number };
  via: SessionMeasure & { totalBytes: number };
  mcp2cli?: SessionMeasure & { totalBytes: number };
}

export interface SuiteMeasure {
  injection: InjectionMeasure;
  viaPromptBytes: number;
  mcp2cli?: { version: string; fixedBytes: number };
  tasks: TaskMeasure[];
}

/** What the caller supplies per sandbox: how to run `via` and, optionally, `mcp2cli`. */
export interface Runners {
  via: Exec;
  mcp2cli?: {
    exec: Exec;
    version: string;
    /** One-time setup (baking server aliases); not counted. */
    prepare(urls: Readonly<Record<string, string>>): Promise<void>;
  };
}

export type RunnerFactory = (sandbox: Sandbox) => Runners | Promise<Runners>;

export interface MeasureOptions {
  loaded: LoadedSuite;
  runners: RunnerFactory;
  /** Progress lines for the console. */
  log?: (line: string) => void;
  /** Every executed command with its (normalized) output, for authoring and debugging tasks. */
  trace?: (label: string, command: string, stdout: string, stderr: string) => void;
}

const CURSOR = /via more ([0-9a-f]{4,16})\b/;

const signature = (server: string, entry: ReplayLogEntry): string => `${server}/${entry.tool} ${JSON.stringify(sortKeys(entry.args))}`;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

/** Run the scripted commands in order; `{cursor}` is the last `via more <id>` an earlier step printed. */
export async function runSession(label: string, program: string, steps: readonly Step[], exec: Exec, sandboxRoot: string, trace?: MeasureOptions['trace']): Promise<StepMeasure[]> {
  const out: StepMeasure[] = [];
  let cursor: string | undefined;
  for (const step of steps) {
    const command = cursor === undefined ? step.run : step.run.replaceAll('{cursor}', cursor);
    if (command.includes('{cursor}')) throw new Error(`${label}: "${step.run}" needs a cursor but no earlier step printed one`);
    const words = splitCommand(command);
    if (words[0] !== program) throw new Error(`${label}: step must run ${program}: ${command}`);
    const result = await exec(words.slice(1));
    const stdout = normalizeOutput(result.stdout, sandboxRoot);
    const stderr = normalizeOutput(result.stderr, sandboxRoot);
    trace?.(label, command, stdout, stderr);
    const expected = step.exit ?? 0;
    if (result.code !== expected) {
      throw new Error(`${label}: \`${command}\` exited ${result.code}, expected ${expected}\n${(stderr || stdout).trim()}`);
    }
    cursor = CURSOR.exec(stdout + stderr)?.[1] ?? cursor;
    out.push({ command, commandBytes: bytesOf(command), stdoutBytes: bytesOf(stdout), stderrBytes: bytesOf(stderr), exit: result.code });
  }
  return out;
}

const sessionBytes = (steps: readonly StepMeasure[]): number => steps.reduce((n, s) => n + s.commandBytes + s.stdoutBytes + s.stderrBytes, 0);

export async function measureSuite(options: MeasureOptions): Promise<SuiteMeasure> {
  const { loaded } = options;
  const log = options.log ?? (() => undefined);
  const servers = new Map<string, { calls: ReplayCall[]; log: ReplayLogEntry[]; close(): Promise<void> }>();
  const urls: Record<string, string> = {};
  let sandbox: Sandbox | undefined;
  try {
    for (const name of loaded.suite.mounted) {
      const calls: ReplayCall[] = [];
      const entries: ReplayLogEntry[] = [];
      const protocol = replayProtocolFromEnv();
      const running = await startReplayHttp({ name, tools: loaded.tools.get(name)!, calls, log: entries, ...(protocol ? { protocol } : {}) });
      servers.set(name, { calls, log: entries, close: running.close });
      urls[name] = running.url;
    }
    sandbox = createSandbox(urls);
    const runners = await options.runners(sandbox);
    if (runners.mcp2cli) await runners.mcp2cli.prepare(urls);

    const injection = await measureInjection(urls);

    // Instruction text. `via prompt` lists the providers, so it needs the servers reachable.
    const prompt = await runners.via(['prompt']);
    if (prompt.code !== 0) throw new Error(`via prompt exited ${prompt.code}: ${prompt.stderr}`);
    const viaPromptBytes = bytesOf(normalizeOutput(prompt.stdout, sandbox.root));

    let mcp2cliFixed: number | undefined;
    if (runners.mcp2cli) {
      const skill = readFileSync(join(loaded.root, loaded.suite.mcp2cli.skill), 'utf8');
      // The agent also has to be told which aliases exist; via gets that from `via prompt`.
      const aliases = `Servers: ${loaded.suite.mounted.map((s) => `@${s}`).join(' ')}\n`;
      mcp2cliFixed = bytesOf(skill) + bytesOf(aliases);
    }

    const tasks: TaskMeasure[] = [];
    for (const task of loaded.tasks) {
      log(`task ${task.id}`);
      const arm = (): void => {
        for (const [name, s] of servers) {
          s.calls.splice(0, s.calls.length, ...cannedCalls([task], name, loaded.benchDir));
          s.log.length = 0;
        }
      };
      const collect = (): string[] =>
        [...servers].flatMap(([name, s]) => s.log.map((entry) => signature(name, entry))).sort();

      // native
      arm();
      const nativeRun = await measureNativeCalls(task, urls);
      const expectedCalls = collect();
      const injectionBytes = injection.bytes;
      const native: TaskMeasure['native'] = {
        ...nativeRun,
        injectionBytes,
        totalBytes: injectionBytes * nativeRun.turns + nativeRun.callBytes + nativeRun.resultBytes,
      };

      // The CLI columns must do the same work as the native column: same tools, same arguments.
      const verify = (column: string): void => {
        const unmatched = [...servers].flatMap(([name, s]) => s.log.filter((e) => !e.matched).map((e) => signature(name, e)));
        if (unmatched.length > 0) throw new Error(`${task.id}: ${column} made calls the task has no canned result for:\n  ${unmatched.join('\n  ')}`);
        const actual = collect();
        if (JSON.stringify(actual) !== JSON.stringify(expectedCalls)) {
          throw new Error(`${task.id}: ${column} did not make the same tool calls as native.\n  native: ${expectedCalls.join(' | ')}\n  ${column}: ${actual.join(' | ')}`);
        }
      };

      // via
      arm();
      const viaSteps = await runSession(`${task.id} via`, 'via', task.via, runners.via, sandbox.root, options.trace);
      verify('via');
      const via = { fixedBytes: viaPromptBytes, sessionBytes: sessionBytes(viaSteps), steps: viaSteps, totalBytes: viaPromptBytes + sessionBytes(viaSteps) };

      // mcp2cli
      let mcp2cli: TaskMeasure['mcp2cli'];
      if (runners.mcp2cli && task.mcp2cli) {
        arm();
        const steps = await runSession(`${task.id} mcp2cli`, 'mcp2cli', task.mcp2cli, runners.mcp2cli.exec, sandbox.root, options.trace);
        verify('mcp2cli');
        mcp2cli = { fixedBytes: mcp2cliFixed!, sessionBytes: sessionBytes(steps), steps, totalBytes: mcp2cliFixed! + sessionBytes(steps) };
      }
      tasks.push({ id: task.id, title: task.title, goal: task.goal, native, via, ...(mcp2cli ? { mcp2cli } : {}) });
    }

    return {
      injection,
      viaPromptBytes,
      ...(runners.mcp2cli ? { mcp2cli: { version: runners.mcp2cli.version, fixedBytes: mcp2cliFixed! } } : {}),
      tasks,
    };
  } finally {
    sandbox?.cleanup();
    await Promise.all([...servers.values()].map((s) => s.close()));
  }
}
