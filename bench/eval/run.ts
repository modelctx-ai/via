// Orchestration: every (trial, task, condition) is one job with its own replay servers and
// sandbox; jobs run with bounded concurrency; the finished records come back in a stable order.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeOutput } from '../harness/exec';
import type { LoadedSuite } from '../harness/load';
import type { RunnerFactory } from '../harness/measure';
import type { Task } from '../harness/types';
import { createEnv } from './env';
import { judge, successOf } from './judge';
import { runAgent } from './loop';
import { buildSystemPrompt } from './prompts';
import { cliTools, nativeTools, type AgentTools } from './tools';
import type { Condition, ModelFactory, RunRecord } from './types';
import { CONDITIONS } from './types';

export interface EvalRunOptions {
  loaded: LoadedSuite;
  conditions: readonly Condition[];
  trials: number;
  maxTurns: number;
  maxTokens: number;
  concurrency: number;
  /** How `via`, `mcp2cli` and `mcpc` are run inside a sandbox. */
  runners: RunnerFactory;
  model: ModelFactory;
  /** One line per finished run. */
  log?: (line: string) => void;
}

interface Job {
  task: Task;
  condition: Condition;
  trial: number;
}

/** Jobs trial by trial, so an interrupted evaluation still has balanced trials. */
export function planJobs(tasks: readonly Task[], conditions: readonly Condition[], trials: number): Job[] {
  const jobs: Job[] = [];
  for (let trial = 1; trial <= trials; trial++) {
    for (const task of tasks) for (const condition of CONDITIONS) if (conditions.includes(condition)) jobs.push({ task, condition, trial });
  }
  return jobs;
}

/** Run `fn` over `items` with at most `limit` in flight; results keep the order of `items`. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** A record for a run that could not even start. */
function failedRun(job: Job, error: unknown, wallMs: number): RunRecord {
  return {
    task: job.task.id,
    condition: job.condition,
    trial: job.trial,
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
    success: false,
    verdict: judge(successOf(job.task), [], ''),
    turns: 0,
    toolCalls: 0,
    errorCalls: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    wallMs,
    finalText: '',
    calls: [],
  };
}

async function runJob(options: EvalRunOptions, job: Job, skills: { mcp2cli?: string; mcpc?: string }): Promise<RunRecord> {
  const started = Date.now();
  const { loaded } = options;
  let env: Awaited<ReturnType<typeof createEnv>> | undefined;
  let tools: AgentTools | undefined;
  try {
    env = await createEnv({ loaded, task: job.task, condition: job.condition, runners: options.runners });
    let viaPrompt: string | undefined;
    if (job.condition === 'native') {
      tools = await nativeTools(env);
    } else if (job.condition === 'via') {
      const prompt = await env.runners!.via(['prompt']);
      if (prompt.code !== 0) throw new Error(`via prompt exited ${prompt.code}: ${prompt.stderr}`);
      viaPrompt = normalizeOutput(prompt.stdout, env.sandbox!.root);
      tools = cliTools('via', env.runners!.via, env);
    } else if (job.condition === 'mcp2cli') {
      tools = cliTools('mcp2cli', env.runners!.mcp2cli!.exec, env);
    } else {
      tools = cliTools('mcpc', env.runners!.mcpc!.exec, env);
    }
    const system = buildSystemPrompt(job.condition, {
      mounted: loaded.suite.mounted,
      ...(viaPrompt !== undefined ? { viaPrompt } : {}),
      ...(skills.mcp2cli !== undefined ? { mcp2cliSkill: skills.mcp2cli } : {}),
      ...(skills.mcpc !== undefined ? { mcpcSkill: skills.mcpc } : {}),
    });
    return await runAgent({
      task: job.task,
      condition: job.condition,
      trial: job.trial,
      model: options.model({ taskId: job.task.id, condition: job.condition }),
      system,
      tools,
      maxTurns: options.maxTurns,
      maxTokens: options.maxTokens,
      calls: env.calls,
    });
  } catch (error) {
    return failedRun(job, error, Date.now() - started);
  } finally {
    await tools?.close();
    await env?.close();
  }
}

export async function runEval(options: EvalRunOptions): Promise<RunRecord[]> {
  const { loaded } = options;
  const jobs = planJobs(loaded.tasks, options.conditions, options.trials);
  const skills = {
    ...(options.conditions.includes('mcp2cli') ? { mcp2cli: readFileSync(join(loaded.root, loaded.suite.mcp2cli.skill), 'utf8') } : {}),
    ...(options.conditions.includes('mcpc') ? { mcpc: readFileSync(join(loaded.root, loaded.suite.mcpc.skill), 'utf8') } : {}),
  };
  let finished = 0;
  const records = await mapLimit(jobs, options.concurrency, async (job) => {
    const record = await runJob(options, job, skills);
    finished += 1;
    options.log?.(
      `[${finished}/${jobs.length}] ${job.condition.padEnd(7)} ${job.task.id} #${job.trial}: ${record.success ? 'success' : `FAIL (${record.status})`}` +
        `, ${record.turns} turns, ${record.toolCalls} calls (${record.errorCalls} errors), ${record.tokens.total.toLocaleString('en-US')} tokens, ${(record.wallMs / 1000).toFixed(1)}s` +
        (record.error ? `: ${record.error}` : ''),
    );
    return record;
  });
  return records;
}
