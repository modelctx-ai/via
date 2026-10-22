// `via tasks <provider> [<task-id>] [--status | --cancel]` (cli.md, "任务"; ADR 0020): the tasks a server runs for
// via, from either generation of the protocol. A call that became a task is followed to its result by the call
// itself (`--detach` returns the task id instead); this command lists tasks, asks for one's state, waits for its result
// and cancels it. It shares the provider resolution and the render pipeline with `via resources`.
import { ClientError, taskRef } from '../../client/errors';
import type { TaskInfo } from '../../protocol';
import { formatError } from '../../render/errors';
import { ExitCode } from '../../render/exit-codes';
import { shellWords, visibleText } from '../../render/shell';
import type { ToolResult } from '../../render/types';
import { alignRows } from '../../render/width';
import { toErrorInfo, type App } from '../app';
import { Elicitation } from '../elicit';
import { CliFailure, usageFailure } from '../failure';
import { noteCanonical, resolveEntry } from '../target';
import type { TaskRecords } from '../task-record';
import type { ProviderEntry } from '../directory';
import { print, safe } from './mcp-data';

const USAGE = 'usage: via tasks <provider> [<task-id>] [--status | --cancel]';

/** How many of via's own recorded tasks a listing asks the server about. */
const LISTED = 20;

export async function tasksCommand(app: App, argv: readonly string[]): Promise<number> {
  const positionals: string[] = [];
  let status = false;
  let cancel = false;
  for (const word of argv) {
    if (word === '--status') status = true;
    else if (word === '--cancel') cancel = true;
    else if (word.startsWith('-') && word !== '-') throw usageFailure(`via tasks: unknown option ${visibleText(word)}`, 'via tasks -h');
    else positionals.push(word);
  }
  if (positionals.length === 0 || positionals.length > 2 || (status && cancel)) throw usageFailure(USAGE, 'via tasks -h');
  const [first, second] = positionals as [string, string | undefined];
  // `gh/job/1`: the task id with its provider in front, as `--detach` prints it. A provider name has no `/`; the id may.
  const slash = second === undefined ? first.indexOf('/') : -1;
  const typed = slash > 0 ? first.slice(0, slash) : first;
  const id = slash > 0 ? first.slice(slash + 1) : second;
  if (slash === 0 || (slash > 0 && id === '')) throw usageFailure(USAGE, 'via tasks -h');
  if ((status || cancel) && id === undefined) throw usageFailure(`${status ? '--status' : '--cancel'} needs a task id: ${USAGE}`, 'via tasks -h');

  const entry = await resolveEntry(app, typed);
  noteCanonical(app, ['tasks', typed], ['tasks', entry.name]);
  const timeoutMs = app.options.timeoutMs ?? entry.server.timeout * 1000;
  const started = app.io.now();
  const backend = await app.backend();
  const records = await app.taskRecords();
  const ref = `tasks ${entry.name}`;
  const refWords = ['tasks', entry.name];

  if (id === undefined) {
    const listed = await listing(app, entry, records, timeoutMs);
    return print(app, entry, ref, started, listed.result, refWords, listed.waiting ? { next: nextCommand(entry, listed.waiting) } : {});
  }

  if (cancel) {
    const task = await backend.cancelTask(entry.server.name, id, { timeoutMs });
    remember(records, entry, task);
    if (task.status === 'completed' || task.status === 'failed') {
      throw new CliFailure({ code: ExitCode.ToolError, message: `${visibleText(taskRef(entry.name, id))} was not cancelled: it already ${task.status === 'failed' ? 'failed' : 'completed'}`, next: nextCommand(entry, id) });
    }
    const pending = task.status !== 'cancelled';
    return print(app, entry, ref, started, stateResult(entry, safe(app, task), pending ? 'cancellation requested; the server still reports the task as running' : undefined), refWords);
  }
  if (status) {
    const task = await backend.getTask(entry.server.name, id, { timeoutMs });
    remember(records, entry, task);
    // A task that waits for the person is not asked about here: the state says so and `next:` is the command that asks.
    const waiting = task.status === 'input_required';
    return print(app, entry, ref, started, stateResult(entry, safe(app, task), waiting ? ANSWER_NOTE : undefined), refWords, waiting ? { next: nextCommand(entry, id) } : {});
  }

  // Wait for the end and print the result as the call itself would have. A task that needs the person's input asks
  // at the terminal, or is declined where there is none, as a call's questions are (ADR 0018, output.md "elicitation").
  const elicitation = new Elicitation(app, { interactive: () => app.io.interactive });
  try {
    const outcome = await backend.waitForTask(entry.server.name, id, { timeoutMs, elicit: elicitation.sink });
    remember(records, entry, outcome.task, outcome.result ? (outcome.result.isError ? 'failed' : 'completed') : undefined);
    if (outcome.result === undefined) {
      const methods = outcome.task.inputMethods ?? [];
      throw new CliFailure({
        code: ExitCode.ToolError,
        message: `${visibleText(taskRef(entry.name, id))} is waiting for input${methods.length > 0 ? ` (${methods.map((m) => visibleText(m)).join(', ')})` : ''}, which via cannot give`,
        next: `${nextCommand(entry, id)} --cancel`,
      });
    }
    return await print(app, entry, ref, started, safe(app, outcome.result), refWords, { elicitation });
  } catch (error) {
    if (!elicitation.declined) throw error;
    // The failure keeps its code, with the declined question in front of it (or, for the server's own failure, as exit code 5).
    const info = await toErrorInfo(error);
    const reported = await elicitation.apply({ exitCode: info.code, stderr: await app.redactText(formatError(info, app.options.format, app.redact)), error: info });
    app.err(reported.stderr);
    return reported.exitCode;
  }
}

/** On `--status` of a task that waits for the person (`input_required`): what it is and, in `next:`, the command that answers. */
const ANSWER_NOTE = 'the server is waiting for the user to answer a question; the command in next: asks it in a terminal';

const nextCommand = (entry: ProviderEntry, id: string): string => `via ${shellWords(['tasks', entry.name, id])}`;

/** Keep the status in via's record current for a task it made. */
function remember(records: TaskRecords, entry: ProviderEntry, task: TaskInfo, status = task.status): void {
  const found = records.find(entry.server, task.id);
  if (found) records.put(entry.server, { ...found, status });
}

/** One task as `key: value` lines (`-o json`: the same fields). */
function stateResult(entry: ProviderEntry, task: TaskInfo, note?: string): ToolResult {
  return {
    content: [],
    structuredContent: {
      task: taskRef(entry.name, task.id),
      status: task.status,
      ...(task.message ? { message: task.message } : {}),
      ...(task.error ? { error: task.error } : {}),
      ...(task.inputMethods ? { waiting_for: task.inputMethods.join(', ') } : {}),
      ...(task.createdAt ? { created: task.createdAt } : {}),
      ...(task.updatedAt ? { updated: task.updatedAt } : {}),
      ...(note ? { note } : {}),
    },
  };
}

/**
 * The listing: the server's own when it keeps one (2025-11-25 with `tasks.list`), else the tasks via recorded, each asked
 * about once (the most recent {@link LISTED}); a task the server no longer knows is marked `expired` and dropped from the record.
 */
async function listing(app: App, entry: ProviderEntry, records: TaskRecords, timeoutMs: number): Promise<{ result: ToolResult; waiting?: string }> {
  const backend = await app.backend();
  const recorded = records.list(entry.server);
  const toolOf = new Map(recorded.map((r) => [r.id, r.tool]));
  const listed = await backend.listTasks(entry.server.name, { timeoutMs });
  type Row = { id: string; status: string; tool?: string; created?: string; message?: string };
  let rows: Row[];
  let source: 'server' | 'record';
  if (listed.tasks) {
    source = 'server';
    rows = listed.tasks.map((t) => ({ id: t.id, status: t.status, ...(toolOf.has(t.id) ? { tool: toolOf.get(t.id)! } : {}), ...(t.createdAt ? { created: t.createdAt } : {}), ...(t.message ? { message: t.message } : {}) }));
  } else {
    source = 'record';
    rows = await Promise.all(
      recorded.slice(0, LISTED).map(async (r): Promise<Row> => {
        const base = { id: r.id, tool: r.tool, created: new Date(r.createdAt).toISOString() };
        try {
          const task = await backend.getTask(entry.server.name, r.id, { timeoutMs });
          if (task.status !== r.status) records.put(entry.server, { ...r, status: task.status });
          return { ...base, status: task.status, ...(task.createdAt ? { created: task.createdAt } : {}), ...(task.message ? { message: task.message } : {}) };
        } catch (error) {
          if (error instanceof ClientError && error.exitCode === ExitCode.NotFound) {
            records.remove(entry.server, r.id);
            return { ...base, status: 'expired' };
          }
          return { ...base, status: `${r.status ?? 'unknown'}?` };
        }
      }),
    );
  }
  const shown = safe(app, rows);
  // A task that waits for the person is not asked about here: its id goes to `next:`, the command that asks.
  const waiting = rows.find((r) => r.status === 'input_required')?.id;
  const found = (result: ToolResult): { result: ToolResult; waiting?: string } => ({ result, ...(waiting !== undefined ? { waiting } : {}) });
  if (app.options.format === 'json') {
    return found({ content: [], structuredContent: { source, tasks: shown.map((r) => ({ ...r, ref: taskRef(entry.name, r.id) })) } });
  }
  if (shown.length === 0) {
    return found({ content: [{ type: 'text', text: source === 'record' ? '(no tasks)\n(this server keeps no task list; via lists the tasks it started)' : '(no tasks)' }] });
  }
  const lines = alignRows(shown.map((r) => [visibleText(taskRef(entry.name, r.id)), visibleText(r.status), visibleText(r.tool ?? '-'), visibleText(r.created ?? '-')]));
  lines.push(source === 'record' ? '(this server keeps no task list; these are the tasks via started)' : `→ via tasks ${shellWords(entry.name)} <task-id> waits for a task and prints its result`);
  return found({ content: [{ type: 'text', text: lines.join('\n') }] });
}
