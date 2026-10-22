// Tasks, both generations (cli.md, "任务"; ADR 0020): the 2025-11-25 core feature and the 2026-07-28
// `io.modelcontextprotocol/tasks` extension, reduced to one `TaskInfo`. Pure and SDK-free apart from types: the
// session sends the requests; this reads what comes back, and holds the one workaround the SDK needs.
import type { TaskInfo } from '../protocol';

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

const STATUSES = ['working', 'input_required', 'completed', 'failed', 'cancelled'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `completed`, `failed` and `cancelled` never change again. */
export function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * A task as either generation sends it, or undefined when it is not one. The 2025 `CreateTaskResult` wraps it
 * (`{task: {…}}`), `tasks/get` and the 2026 `CreateTaskResult` do not; the time fields are `ttl`/`pollInterval` in
 * 2025 and `ttlMs`/`pollIntervalMs` in 2026, both in milliseconds. Strict about what a client acts on (the id and
 * the status), lenient about the rest.
 */
export function readTask(raw: unknown): TaskInfo | undefined {
  const value = isRecord(raw) && isRecord(raw.task) ? raw.task : raw;
  if (!isRecord(value)) return undefined;
  const { taskId, status } = value;
  if (typeof taskId !== 'string' || taskId === '' || typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status)) return undefined;
  const number = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const task: TaskInfo = { id: taskId, status };
  if (typeof value.statusMessage === 'string' && value.statusMessage !== '') task.message = value.statusMessage;
  if (typeof value.createdAt === 'string') task.createdAt = value.createdAt;
  if (typeof value.lastUpdatedAt === 'string') task.updatedAt = value.lastUpdatedAt;
  const ttl = number(value.ttlMs) ?? number(value.ttl);
  if (ttl !== undefined) task.ttlMs = ttl;
  const poll = number(value.pollIntervalMs) ?? number(value.pollInterval);
  if (poll !== undefined) task.pollMs = poll;
  if (isRecord(value.error) && typeof value.error.message === 'string') task.error = value.error.message;
  if (isRecord(value.inputRequests)) {
    const methods = Object.values(value.inputRequests).map((r) => (isRecord(r) && typeof r.method === 'string' ? r.method : 'unknown request'));
    if (methods.length > 0) task.inputMethods = methods;
  }
  return task;
}

/** Milliseconds to wait before asking again: what the server suggested, kept between 100 ms and 5 s (default 1 s). */
export function pollDelay(task: TaskInfo): number {
  const hint = task.pollMs;
  if (hint === undefined || hint === 0) return 1000;
  return Math.min(5000, Math.max(100, hint));
}

/**
 * The result a 2026 `tasks/get` of a completed task carries inline (`result`), or undefined. It is "the original request's
 * result": a tool result, so it must be an object.
 */
export function inlineResult(raw: unknown): Record<string, unknown> | undefined {
  return isRecord(raw) && isRecord(raw.result) ? raw.result : undefined;
}

/**
 * The SDK's 2026-07-28 decoder accepts only `resultType: "complete"` and `"input_required"`: a `tools/call` answered
 * with a task (`resultType: "task"`, the extension's `CreateTaskResult`) is rejected before anything of via's runs, and
 * the task, with its id, is lost. This is installed in the SDK client's `_onresponse` hook (the SDK's documented
 * subclass seam for inbound responses): it turns such a response into an ordinary, empty result that the decoder
 * accepts and keeps the task on the side; `take` recognizes that result by object identity, so a server cannot
 * make via believe in a task by sending the same words in its own `_meta`. Drop it when the SDK ships the extension.
 */
export class CreatedTaskShim {
  private readonly lifted = new WeakSet<object>();

  rewrite<T extends object>(response: T): T {
    if (!('result' in response)) return response;
    const result: unknown = (response as { result?: unknown }).result;
    if (!isRecord(result) || result.resultType !== 'task') return response;
    const { resultType: _resultType, ...task } = result;
    this.lifted.add(task);
    // `isError` keeps the SDK from checking the (empty) content against the tool's `outputSchema`.
    const placeholder = { resultType: 'complete', content: [], isError: true, _meta: { ...(isRecord(task._meta) ? task._meta : {}), [LIFTED_KEY]: task } };
    return { ...response, result: placeholder } as T;
  }

  /** The task a server created instead of a result, when `result` is the placeholder made by `rewrite`. */
  take(result: unknown): Record<string, unknown> | undefined {
    if (!isRecord(result) || !isRecord(result._meta)) return undefined;
    const task = result._meta[LIFTED_KEY];
    return isRecord(task) && this.lifted.has(task) ? task : undefined;
  }
}

/** Where the placeholder carries the task. Never printed: the session unwraps it first. */
const LIFTED_KEY = 'dev.via/created-task';
