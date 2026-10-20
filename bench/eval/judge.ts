// Deterministic success judging for the agent evaluation. A run succeeded when the replay
// servers' call logs satisfy the task's `success` block: every required call was answered,
// no forbidden call was attempted, writes happened at most `max` times, and (for read-only
// tasks) the final answer mentions the key facts. Nothing here calls a model.
import type { Args, Criterion, Success, Task } from '../harness/types';

/** One `tools/call` a replay server received (`matched` = a canned result answered it). */
export interface LoggedCall {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  matched: boolean;
}

export interface Check {
  kind: 'require' | 'forbid' | 'max' | 'answer';
  /** Human-readable description of the check. */
  label: string;
  ok: boolean;
}

export interface Verdict {
  success: boolean;
  checks: Check[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const isOperator = (spec: Record<string, unknown>): boolean => {
  const keys = Object.keys(spec);
  return keys.length === 1 && keys[0]!.startsWith('$');
};

/** Scalars compare as trimmed, case-insensitive strings so `214` equals `"214"` and `open` equals `OPEN`. */
function looseEqual(expected: unknown, actual: unknown): boolean {
  const scalar = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  if (scalar(expected) && scalar(actual)) return String(expected).trim().toLowerCase() === String(actual).trim().toLowerCase();
  return expected === actual;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined);

/**
 * Does `actual` satisfy `spec`? Plain values compare loosely; objects are subset matches;
 * arrays match element by element, and a one-element array stands for its element. Operators
 * (an object with a single `$` key):
 *
 * - `$contains`: substring of a string (case-insensitive) or an element of an array
 * - `$containsAll`: every listed substring/element is contained
 * - `$regex`: the string form matches the regular expression (case-insensitive)
 * - `$oneOf`: one of the listed specs matches
 * - `$not`: the spec does not match
 * - `$exists`: the key is present (`true`) or absent (`false`)
 */
export function matchSpec(spec: unknown, actual: unknown): boolean {
  if (isRecord(spec) && isOperator(spec)) {
    const [op, arg] = Object.entries(spec)[0]!;
    switch (op) {
      case '$contains': {
        if (Array.isArray(actual)) return actual.some((item) => looseEqual(arg, item));
        const s = text(actual);
        return s !== undefined && text(arg) !== undefined && s.toLowerCase().includes(text(arg)!.toLowerCase());
      }
      case '$containsAll':
        return Array.isArray(arg) && arg.every((item) => matchSpec({ $contains: item }, actual));
      case '$regex': {
        const s = text(actual);
        return s !== undefined && typeof arg === 'string' && new RegExp(arg, 'i').test(s);
      }
      case '$oneOf':
        return Array.isArray(arg) && arg.some((item) => matchSpec(item, actual));
      case '$not':
        return !matchSpec(arg, actual);
      case '$exists':
        return (actual !== undefined) === Boolean(arg);
      default:
        throw new Error(`unknown matcher operator ${op}`);
    }
  }
  if (Array.isArray(spec)) {
    if (Array.isArray(actual)) return spec.length === actual.length && spec.every((item, i) => matchSpec(item, actual[i]));
    return spec.length === 1 && matchSpec(spec[0], actual);
  }
  if (isRecord(spec)) {
    if (!isRecord(actual)) return false;
    return Object.entries(spec).every(([key, value]) => (isRecord(value) && isOperator(value) && '$exists' in value ? true : key in actual) && matchSpec(value, actual[key]));
  }
  if (Array.isArray(actual)) return actual.length === 1 && matchSpec(spec, actual[0]);
  return looseEqual(spec, actual);
}

/** Does a logged call match a criterion's server, tool and argument spec? */
export function matchesCriterion(criterion: Criterion, call: LoggedCall): boolean {
  if (criterion.server !== call.server || criterion.tool !== call.tool) return false;
  return criterion.args === undefined || matchSpec(criterion.args as Args, call.args);
}

const describe = (c: Criterion): string => `${c.server}/${c.tool}${c.args ? ` ${JSON.stringify(c.args)}` : ''}`;

const mentions = (answer: string, want: string | string[]): boolean => (Array.isArray(want) ? want : [want]).some((w) => answer.toLowerCase().includes(w.toLowerCase()));

/** Judge one run. `calls` is every call the replay servers received; `answer` the model's final text. */
export function judge(success: Success, calls: readonly LoggedCall[], answer: string): Verdict {
  const checks: Check[] = [];
  for (const criterion of success.require) {
    const answered = calls.filter((c) => c.matched && matchesCriterion(criterion, c));
    checks.push({ kind: 'require', label: `called ${describe(criterion)}`, ok: answered.length > 0 });
    if (criterion.max !== undefined) {
      checks.push({ kind: 'max', label: `at most ${criterion.max}× ${describe(criterion)} (saw ${answered.length})`, ok: answered.length <= criterion.max });
    }
  }
  for (const criterion of success.forbid ?? []) {
    const attempted = calls.filter((c) => matchesCriterion(criterion, c));
    checks.push({ kind: 'forbid', label: `never called ${describe(criterion)}${attempted.length > 0 ? ` (saw ${attempted.length})` : ''}`, ok: attempted.length === 0 });
  }
  for (const want of success.answer ?? []) {
    checks.push({ kind: 'answer', label: `answer mentions ${Array.isArray(want) ? want.join(' | ') : want}`, ok: mentions(answer, want) });
  }
  return { success: checks.every((c) => c.ok), checks };
}

/** The success block of a task, or an error naming the task: the evaluation needs one for every task. */
export function successOf(task: Task): Success {
  if (!task.success) throw new Error(`task ${task.id} has no \`success\` block; the agent evaluation cannot judge it`);
  return task.success;
}
