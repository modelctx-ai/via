// Aggregating run records per condition and per task, and deciding roadmap gate 1:
// the task success rate with via is not lower than with native MCP, and not lower than with
// mcp2cli (docs/roadmap.md).
import { CONDITIONS, type Condition, type RunRecord } from './types';

export const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((n, x) => n + x, 0) / xs.length);

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 95% Wilson score interval of a proportion; the usual choice for small samples. */
export function wilson(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export interface Stat {
  mean: number;
  median: number;
}

const stat = (xs: readonly number[]): Stat => ({ mean: mean(xs), median: median(xs) });

export interface ConditionSummary {
  condition: Condition;
  runs: number;
  successes: number;
  rate: number;
  /** 95% Wilson interval of the success rate. */
  interval: [number, number];
  /** Runs that ended in an API or harness failure (counted as unsuccessful). */
  aborted: number;
  inputTokens: Stat;
  outputTokens: Stat;
  totalTokens: Stat;
  cacheReadTokens: Stat;
  turns: Stat;
  toolCalls: Stat;
  errorCalls: Stat;
  wallMs: Stat;
}

export interface TaskCell {
  runs: number;
  successes: number;
}

export interface TaskSummary {
  task: string;
  cells: Partial<Record<Condition, TaskCell>>;
}

export interface Comparison {
  versus: Condition;
  via: { successes: number; runs: number; rate: number };
  other: { successes: number; runs: number; rate: number };
  /** via's rate is not lower than the other condition's. */
  holds: boolean;
  /** The 95% intervals overlap, so a difference in either direction is within noise. */
  withinNoise: boolean;
}

export interface Gate {
  /** False for the scripted model and for runs without a via condition. */
  evaluated: boolean;
  /** Every comparison the gate asks for was made (mcp2cli present, native present). */
  complete: boolean;
  /** All comparisons made hold; meaningful only when `evaluated`. */
  holds: boolean;
  comparisons: Comparison[];
  notes: string[];
}

export interface Summary {
  conditions: ConditionSummary[];
  tasks: TaskSummary[];
  gate: Gate;
}

export function summarizeCondition(condition: Condition, runs: readonly RunRecord[]): ConditionSummary {
  const mine = runs.filter((r) => r.condition === condition);
  const successes = mine.filter((r) => r.success).length;
  return {
    condition,
    runs: mine.length,
    successes,
    rate: mine.length === 0 ? 0 : successes / mine.length,
    interval: wilson(successes, mine.length),
    aborted: mine.filter((r) => r.status === 'error').length,
    inputTokens: stat(mine.map((r) => r.tokens.input)),
    outputTokens: stat(mine.map((r) => r.tokens.output)),
    totalTokens: stat(mine.map((r) => r.tokens.total)),
    cacheReadTokens: stat(mine.map((r) => r.tokens.cacheRead)),
    turns: stat(mine.map((r) => r.turns)),
    toolCalls: stat(mine.map((r) => r.toolCalls)),
    errorCalls: stat(mine.map((r) => r.errorCalls)),
    wallMs: stat(mine.map((r) => r.wallMs)),
  };
}

export function gateOf(conditions: readonly ConditionSummary[], options: { fake: boolean; mcp2cliSkipped?: string }): Gate {
  const byName = new Map(conditions.map((c) => [c.condition, c] as const));
  const via = byName.get('via');
  const notes: string[] = [];
  if (options.fake) notes.push('scripted model: the gate says nothing about real models and is not evaluated');
  if (!via || via.runs === 0) {
    notes.push('no via runs');
    return { evaluated: false, complete: false, holds: false, comparisons: [], notes };
  }
  const comparisons: Comparison[] = [];
  let complete = true;
  for (const versus of ['native', 'mcp2cli'] as const) {
    const other = byName.get(versus);
    if (!other || other.runs === 0) {
      complete = false;
      notes.push(
        versus === 'mcp2cli' && options.mcp2cliSkipped ? `no mcp2cli runs: ${options.mcp2cliSkipped}` : `no ${versus} runs; the comparison with ${versus} was not made`,
      );
      continue;
    }
    comparisons.push({
      versus,
      via: { successes: via.successes, runs: via.runs, rate: via.rate },
      other: { successes: other.successes, runs: other.runs, rate: other.rate },
      holds: via.rate >= other.rate,
      withinNoise: via.interval[0] <= other.interval[1] && other.interval[0] <= via.interval[1],
    });
  }
  const holds = comparisons.length > 0 && comparisons.every((c) => c.holds);
  if (comparisons.some((c) => c.withinNoise)) notes.push('some intervals overlap: at this sample size a difference in either direction is within noise; raise --trials for a firmer answer');
  if (via.aborted > 0 || conditions.some((c) => c.aborted > 0)) notes.push('some runs ended in API or harness errors and count as unsuccessful');
  return { evaluated: !options.fake && comparisons.length > 0, complete, holds, comparisons, notes };
}

export function summarize(runs: readonly RunRecord[], options: { conditions: readonly Condition[]; taskOrder: readonly string[]; fake: boolean; mcp2cliSkipped?: string }): Summary {
  const conditions = options.conditions.map((c) => summarizeCondition(c, runs));
  const tasks: TaskSummary[] = options.taskOrder
    .filter((task) => runs.some((r) => r.task === task))
    .map((task) => {
      const cells: TaskSummary['cells'] = {};
      for (const condition of CONDITIONS) {
        const mine = runs.filter((r) => r.task === task && r.condition === condition);
        if (mine.length > 0) cells[condition] = { runs: mine.length, successes: mine.filter((r) => r.success).length };
      }
      return { task, cells };
    });
  return { conditions, tasks, gate: gateOf(conditions, options) };
}
