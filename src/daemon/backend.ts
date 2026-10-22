// The CLI's daemon backend: every operation that touches an MCP server becomes a request on the
// socket (daemon.md). Parsing and rendering stay in the CLI; this file only translates between the
// `Backend` interface and protocol messages. It imports no MCP SDK and no ajv.
import type { Backend, Listing, ListingOptions } from '../cli/backend';
import type { Compiled, CompileResult, SchemaCompiler } from '../cli/args/validate';
import type { McpTool } from '../catalog/types';
import { ClientError } from '../client/errors';
import type { ElicitAnswer, ElicitQuestion } from '../client/elicit';
import type { CallOptions, ListOptions } from '../client/session';
import type { ServerConfig } from '../config/types';
import type { CatalogCache } from '../cli/catalog-cache';
import type {
  CompletionRef,
  CompletionResult,
  CursorGetResult,
  DetachedCall,
  TaskInfo,
  TaskList,
  TaskOutcome,
  ErrorInfo,
  Event,
  GetPromptResult,
  ListResult,
  McpPrompt,
  ProtocolInfo,
  ReadResourceResult,
  RequestBody,
  ResourceListing,
  Response,
  ServerFeatures,
  ServerSelf,
  ServerTarget,
  SkillEntry,
  SkillRead,
  ToolCallResult,
  ValidateResult,
} from '../protocol';
import type { CursorRecord, CursorStore } from '../render/cursor';
import { ExitCode } from '../render/exit-codes';
import { DaemonUnavailable, type DaemonClient } from './client';
import { envStamp } from './target';

export interface DaemonBackendOptions {
  client: DaemonClient;
  /** Every configured server; requests name one by key or provider. */
  servers: readonly ServerConfig[];
  cwd: string;
  /** The CLI's environment, only for `envStamp` digests. */
  env: Readonly<Record<string, string | undefined>>;
  /** `daemon.serverIdleTimeout`, seconds. */
  serverIdleTimeoutSec: number;
  /**
   * The disk cache the daemon writes too. When the daemon answers a `have` with "unchanged", the
   * tools (if anyone asks for them) are read from the file instead of coming over the socket.
   */
  cache?: CatalogCache;
  /** `log` events of level `warning` from the daemon, as text for stderr. */
  onWarning?: (message: string) => void;
}

/** Slack on top of a request's own timeout before the CLI gives up on a daemon that stopped answering. */
const DEADLINE_SLACK_MS = 30_000;

export class DaemonBackend implements Backend {
  readonly mode = 'daemon';

  constructor(private readonly options: DaemonBackendOptions) {}

  async listing(server: ServerConfig, { timeoutMs, refresh, have }: ListingOptions): Promise<Listing> {
    // Say which list we already have a build of, if the cache file that would supply its tools is there.
    const disk = !refresh && have !== undefined ? this.options.cache?.read(server) : undefined;
    const known = disk !== undefined && disk.fetchedAt === have ? have : undefined;
    const response = await this.send(
      { type: 'list', ...this.target(server), timeoutMs, ...(refresh ? { refresh: true } : {}), ...(known !== undefined ? { have: known } : {}) },
      { deadlineMs: timeoutMs + DEADLINE_SLACK_MS, onEvent: (event) => this.onLog(event) },
    );
    const result = unwrap<ListResult>(response);
    if (!('unchanged' in result)) {
      // The daemon wrote its cache file before answering: its length identifies this list for the
      // prebuilt-catalog cache, as it does for a list read from the file here.
      const written = this.options.cache?.read(server);
      return written && written.fetchedAt === result.fetchedAt ? { ...result, rawBytes: written.rawBytes } : result;
    }
    // The daemon's list is the one in the cache file we just read (the daemon wrote it): the tools,
    // if anyone asks for them, are parsed from there instead of coming over the socket.
    if (!disk || disk.fetchedAt !== result.fetchedAt) return this.listing(server, { timeoutMs, refresh: true });
    const features = result.features ?? disk.features;
    const protocol = result.protocol ?? disk.protocol;
    return {
      fetchedAt: disk.fetchedAt,
      fromCache: true,
      rawBytes: disk.rawBytes,
      ...(features ? { features } : {}),
      ...(protocol ? { protocol } : {}),
      get tools() {
        return disk.tools;
      },
    };
  }

  async listTools(server: string, options: ListOptions = {}): Promise<McpTool[]> {
    const config = this.find(server);
    const listing = await this.listing(config, { timeoutMs: options.timeoutMs ?? config.timeout * 1000, refresh: true });
    return listing.tools;
  }

  async callTool(server: string, rawName: string, args: Record<string, unknown> = {}, options: CallOptions = {}): Promise<ToolCallResult> {
    const config = this.find(server);
    const timeoutMs = options.timeoutMs ?? config.timeout * 1000;
    const response = await this.send(
      {
        type: 'call',
        ...this.target(config),
        rawName,
        args,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.retry ? { retry: true } : {}),
        ...(options.onProgress ? { progress: true } : {}),
        ...(options.taskSupport !== undefined ? { taskSupport: options.taskSupport } : {}),
        ...(options.onTask ? { tasks: true } : {}),
        ...(options.elicit ? { elicit: true as const } : {}),
      },
      {
        deadlineMs: timeoutMs * (options.retry ? 2 : 1) + DEADLINE_SLACK_MS,
        onEvent: (event) => this.onCallEvent(event, options),
      },
    );
    return unwrap<ToolCallResult>(response);
  }

  async detachTool(server: string, rawName: string, args: Record<string, unknown> = {}, options: CallOptions = {}): Promise<DetachedCall> {
    const config = this.find(server);
    const timeoutMs = options.timeoutMs ?? config.timeout * 1000;
    const response = await this.send(
      {
        type: 'call',
        ...this.target(config),
        rawName,
        args,
        detach: true,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.onProgress ? { progress: true } : {}),
        ...(options.taskSupport !== undefined ? { taskSupport: options.taskSupport } : {}),
        ...(options.onTask ? { tasks: true } : {}),
        ...(options.elicit ? { elicit: true as const } : {}),
      },
      { deadlineMs: timeoutMs + DEADLINE_SLACK_MS, onEvent: (event) => this.onCallEvent(event, options) },
    );
    return unwrap<DetachedCall>(response);
  }

  private onCallEvent(event: Event, options: CallOptions): void {
    this.onLog(event);
    if (event.event === 'progress' && options.onProgress) options.onProgress(event.data as Parameters<NonNullable<CallOptions['onProgress']>>[0]);
    if (event.event === 'task' && options.onTask) options.onTask(event.data as TaskInfo);
    if (event.event === 'elicit' && options.elicit) void this.answer(options.elicit, event);
  }

  private async taskRequest<T>(server: string, action: 'get' | 'wait' | 'cancel' | 'list', taskId: string | undefined, options: ListOptions): Promise<T> {
    const config = this.find(server);
    const timeoutMs = options.timeoutMs ?? config.timeout * 1000;
    return unwrap<T>(await this.send({ type: 'task', action, ...(taskId !== undefined ? { taskId } : {}), ...this.target(config), timeoutMs }, { deadlineMs: timeoutMs + DEADLINE_SLACK_MS }));
  }

  getTask(server: string, taskId: string, options: ListOptions = {}): Promise<TaskInfo> {
    return this.taskRequest<TaskInfo>(server, 'get', taskId, options);
  }

  waitForTask(server: string, taskId: string, options: ListOptions = {}): Promise<TaskOutcome> {
    return this.taskRequest<TaskOutcome>(server, 'wait', taskId, options);
  }

  cancelTask(server: string, taskId: string, options: ListOptions = {}): Promise<TaskInfo> {
    return this.taskRequest<TaskInfo>(server, 'cancel', taskId, options);
  }

  listTasks(server: string, options: ListOptions = {}): Promise<TaskList> {
    return this.taskRequest<TaskList>(server, 'list', undefined, options);
  }

  /** The daemon relays a server's question to the person behind this call: ask `sink`, send the answer back (daemon.md, "elicitation"). */
  private async answer(sink: NonNullable<CallOptions['elicit']>, event: Event): Promise<void> {
    const { key, question } = event.data as { key?: unknown; question?: ElicitQuestion };
    if (typeof key !== 'string' || !question) return;
    let answer: ElicitAnswer;
    try {
      answer = await sink.ask(question);
    } catch {
      answer = { action: 'cancel' };
    }
    try {
      await this.send({ type: 'elicit-reply', call: event.id, key, answer }, { deadlineMs: 10_000, spawn: false });
    } catch {
      // The daemon is gone or the call is over: nobody is waiting for the answer any more.
    }
  }

  /** A `log` event is `{ level: 'warning', message }`; other levels are not shown. */
  private onLog(event: Event): void {
    if (event.event !== 'log') return;
    const data = event.data as { level?: unknown; message?: unknown } | null;
    if (data?.level === 'warning' && typeof data.message === 'string') this.options.onWarning?.(data.message);
  }

  async listResources(server: string, options: ListOptions = {}): Promise<ResourceListing> {
    const config = this.find(server);
    const timeoutMs = options.timeoutMs ?? config.timeout * 1000;
    return unwrap<ResourceListing>(await this.send({ type: 'resources-list', ...this.target(config), timeoutMs }, { deadlineMs: timeoutMs + DEADLINE_SLACK_MS }));
  }

  async readResource(server: string, uri: string, options: ListOptions = {}): Promise<ReadResourceResult> {
    const config = this.find(server);
    const timeoutMs = options.timeoutMs ?? config.timeout * 1000;
    return unwrap<ReadResourceResult>(await this.send({ type: 'resource-read', ...this.target(config), uri, timeoutMs }, { deadlineMs: timeoutMs + DEADLINE_SLACK_MS }));
  }

  async listPrompts(server: string, options: ListOptions = {}): Promise<McpPrompt[]> {
    const config = this.find(server);
    const timeoutMs = options.timeoutMs ?? config.timeout * 1000;
    return unwrap<McpPrompt[]>(await this.send({ type: 'prompts-list', ...this.target(config), timeoutMs }, { deadlineMs: timeoutMs + DEADLINE_SLACK_MS }));
  }

  async getPrompt(server: string, name: string, args: Record<string, string>, options: ListOptions = {}): Promise<GetPromptResult> {
    const config = this.find(server);
    const timeoutMs = options.timeoutMs ?? config.timeout * 1000;
    return unwrap<GetPromptResult>(await this.send({ type: 'prompt-get', ...this.target(config), name, args, timeoutMs }, { deadlineMs: timeoutMs + DEADLINE_SLACK_MS }));
  }

  async listSkills(server: string, options: ListOptions = {}): Promise<SkillEntry[]> {
    const config = this.find(server);
    const timeoutMs = options.timeoutMs ?? config.timeout * 1000;
    return unwrap<SkillEntry[]>(await this.send({ type: 'skills-list', ...this.target(config), timeoutMs }, { deadlineMs: timeoutMs + DEADLINE_SLACK_MS, onEvent: (event) => this.onLog(event) }));
  }

  async readSkill(server: string, skill: string, file?: string, options: ListOptions = {}): Promise<SkillRead> {
    const config = this.find(server);
    const timeoutMs = options.timeoutMs ?? config.timeout * 1000;
    return unwrap<SkillRead>(await this.send({ type: 'skill-read', ...this.target(config), skill, ...(file !== undefined ? { file } : {}), timeoutMs }, { deadlineMs: timeoutMs + DEADLINE_SLACK_MS }));
  }

  async complete(server: string, ref: CompletionRef, argument: { name: string; value: string }, context?: Record<string, string>, options: ListOptions = {}): Promise<CompletionResult> {
    const config = this.find(server);
    const timeoutMs = options.timeoutMs ?? config.timeout * 1000;
    return unwrap<CompletionResult>(
      await this.send({ type: 'complete', ...this.target(config), ref, argument, ...(context ? { context } : {}), timeoutMs }, { deadlineMs: timeoutMs + DEADLINE_SLACK_MS }),
    );
  }

  /** The daemon returns `features` with every listing; there is no other source in this process. */
  features(): ServerFeatures | undefined {
    return undefined;
  }

  /** What a server says about itself is written to the catalog cache by the daemon (`CatalogCache.readInfo`). */
  info(): ServerSelf | undefined {
    return undefined;
  }

  /** Likewise `protocol`: it comes with the listing. */
  protocol(): ProtocolInfo | undefined {
    return undefined;
  }

  /**
   * Validation in the daemon, which keeps compiled schemas. Any trouble reaching it falls back to
   * ajv in this process: validation has no side effects, so nothing is lost but the time it costs.
   */
  compiler(): SchemaCompiler {
    return async (schema, label): Promise<CompileResult> => {
      const local = async (): Promise<CompileResult> => (await import('../cli/args/validate')).compileSchema(schema, label);
      let first: ValidateResult;
      try {
        first = unwrap<ValidateResult>(await this.send({ type: 'validate', schema, label, compileOnly: true }, { deadlineMs: 10_000, spawn: true }));
      } catch (error) {
        if (error instanceof DaemonUnavailable) return local();
        throw error;
      }
      if (!first.ok) return { ok: false, reason: first.reason, warnings: first.warnings };
      let formats: unknown[] = [];
      const compiled: Compiled = {
        warnings: first.warnings,
        check: async (data) => {
          try {
            const result = unwrap<ValidateResult>(await this.send({ type: 'validate', schema, label, data }, { deadlineMs: 10_000 }));
            if (!result.ok) return [];
            formats = result.formats;
            return result.errors as Awaited<ReturnType<Compiled['check']>>;
          } catch (error) {
            if (!(error instanceof DaemonUnavailable)) throw error;
            const fallback = await local();
            if (!fallback.ok) return [];
            const errors = await fallback.compiled.check(data);
            if (errors.length === 0) formats = await fallback.compiled.formats(data);
            return errors;
          }
        },
        formats: async () => formats as Awaited<ReturnType<Compiled['formats']>>,
      };
      return { ok: true, compiled };
    };
  }

  cursors(): CursorStore {
    return new DaemonCursorStore(this.options.client, true);
  }

  /** Only asks a daemon that is already there: without one nothing could have been redacted. */
  async redactValue<T>(value: T): Promise<T> {
    if (value === undefined || value === null) return value;
    try {
      const conn = await this.options.client.connection({ spawn: false });
      if (!conn) return value;
      const response = await conn.request({ type: 'redact', value }, { deadlineMs: 5000 });
      return response.ok ? (response.result as T) : value;
    } catch {
      return value;
    }
  }

  /** Only asks a daemon that is already there: without one nothing could have been redacted. */
  async redact(text: string): Promise<string> {
    if (text === '') return text;
    try {
      const conn = await this.options.client.connection({ spawn: false });
      if (!conn) return text;
      const response = await conn.request({ type: 'redact', text }, { deadlineMs: 5000 });
      return response.ok ? (response.result as string) : text;
    } catch {
      return text;
    }
  }

  secrets(): readonly string[] {
    return [];
  }

  async close(): Promise<void> {
    this.options.client.close();
  }

  // Internals ---------------------------------------------------------------------------

  /** The configured server a name or provider refers to, as `InProcessClient` resolves it. */
  private find(key: string): ServerConfig {
    const visible = this.options.servers.filter((s) => !s.disabled);
    const found = visible.find((s) => s.name === key) ?? visible.find((s) => s.provider === key);
    if (found) return found;
    throw new ClientError({
      exitCode: ExitCode.NotFound,
      message: `no such server: ${key}`,
      next: 'via servers',
      ...(visible.length > 0 ? { candidates: visible.map((s) => s.provider).filter((p) => p.includes(key) || key.includes(p)).slice(0, 5) } : {}),
    });
  }

  private target(server: ServerConfig): ServerTarget {
    return { server, cwd: this.options.cwd, idleTimeout: this.options.serverIdleTimeoutSec, envStamp: envStamp(server, this.options.env) };
  }

  /**
   * Send one request, starting the daemon when needed. A daemon that answers `stale` (the values of
   * the server's `env:` variables in this shell are not the ones it resolves) is not restarted and is
   * not told the values: `DaemonStale` goes to the caller, which runs this request in-process.
   */
  private async send(body: RequestBody, options: { onEvent?: (event: Event) => void; deadlineMs?: number; spawn?: boolean } = {}): Promise<Response> {
    const { client } = this.options;
    const conn = await client.connection({ spawn: options.spawn ?? true });
    if (!conn) throw new DaemonUnavailable('the via daemon is not running');
    return conn.request(body, { ...(options.onEvent ? { onEvent: options.onEvent } : {}), ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}) });
  }
}

function unwrap<T>(response: Response): T {
  if (response.ok) return response.result as T;
  throw new ClientError(response.error as ErrorInfo);
}

/** Cursors kept by the daemon (output.md, "游标"). `spawn` allows starting a daemon to put one. */
export class DaemonCursorStore implements CursorStore {
  constructor(
    private readonly client: DaemonClient,
    private readonly spawn: boolean,
  ) {}

  async put(record: CursorRecord): Promise<string> {
    const conn = await this.client.connection({ spawn: this.spawn });
    if (!conn) throw new DaemonUnavailable('the via daemon is not running');
    return unwrap<string>(await conn.request({ type: 'cursor-put', record }, { deadlineMs: 10_000 }));
  }

  async get(id: string): Promise<CursorRecord | undefined> {
    const conn = await this.client.connection({ spawn: false });
    if (!conn) return undefined;
    const { record } = unwrap<CursorGetResult>(await conn.request({ type: 'cursor-get', cursor: id }, { deadlineMs: 10_000 }));
    return record ?? undefined;
  }
}
