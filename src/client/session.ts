// One MCP session per server over stdio or Streamable HTTP. The SDK is imported lazily, on the first
// connection, so nothing here costs CLI cold start (implementation.md, "启动速度").
import type { Client, ClientOptions, FetchLike, McpSubscription, StandardSchemaV1, SubscriptionFilter, Transport } from '@modelcontextprotocol/client';
import pkg from '../../package.json';
import type { CredentialResolver, ServerConfig } from '../config/types';
import type { CompletionRef, CompletionResult, DetachedCall, GetPromptResult, SkillEntry, SkillRead, TaskInfo, TaskList, TaskOutcome, McpPrompt, ProtocolInfo, ReadResourceResult, ResourceListing, ServerFeatures, ServerSelf, ToolCallResult } from '../protocol';
import type { McpTool } from '../catalog/types';
import { createRedactor, redactValue } from '../render/redact';
import { resolveConnection, type ResolvedConnection } from './credentials';
import { cannotDetach, ClientError, internal, isNotFoundCode, mapError, noFeature, noSkills, noTasks, taskNeedsInput, taskNotFound, taskStillRunning, notFoundServer, resourceNotFound, skillNotFound, skillRefused, timedOut, untrustedServer, type Phase } from './errors';
import { prepareStdioCommand } from '../platform/command';
import { isModernProtocolVersion } from '../protocol-versions';
import { proxyFetch } from '../proxy';
import { describeQuestion, ELICITATION_CAPABILITY, parseAnswer, parseQuestion, urlElicitationsOf, type ElicitAnswer, type ElicitQuestion, type ElicitSink } from './elicit';
import { originOf, programOf, type ServerLog } from '../log';
import { Limiter } from './limiter';
import { resolveRoots } from './roots';
import { describeServer } from './server-info';
import { CreatedTaskShim, inlineResult, isTerminal, pollDelay, readTask, TASKS_EXTENSION } from './tasks';
import { chooseFile, contentBytes, parseSkillEntry, SKILLS_EXTENSION, verifyFile } from './skills';
import type { ViaOAuthProvider } from './oauth/provider';
import type { OAuthStore } from './oauth/store';

export interface CallOptions {
  /** Overrides `ServerConfig.timeout` for this call. */
  timeoutMs?: number;
  /** Retry once after a timeout or lost connection. Callers pass this only for `readOnlyHint` tools. */
  retry?: boolean;
  /** The tool's declared `execution.taskSupport` (2025-11-25); decides whether a task is asked for (cli.md, "任务"). */
  taskSupport?: string;
  /** Called once when the call became a task, with the task as the server first described it. */
  onTask?: (task: TaskInfo) => void;
  /** Called for upstream `notifications/progress` (arguments.md, "调用过程"). */
  onProgress?: (progress: { progress: number; total?: number; message?: string }) => void;
  /** Something the person should know about, caused by this call (see `SessionOptions.onWarning`). */
  onWarning?: (message: string) => void;
  /** Who answers the questions a server asks the person during this call (elicitation, ADR 0018); none: they are declined. */
  elicit?: ElicitSink;
}

export interface ListOptions {
  timeoutMs?: number;
  /**
   * The server's own cache hint for what is being listed: `ttlMs` of a stateless-protocol `tools/list`
   * result, called only for a positive value (a server that sends `0` or nothing gave no usable hint:
   * discovery.md, "缓存").
   */
  onTtl?: (ttlMs: number) => void;
  /** Something the person should know about, caused by this operation (see `SessionOptions.onWarning`). */
  onWarning?: (message: string) => void;
}

export interface SessionOptions {
  /** Where OAuth logins live (auth.md). Default: the user's keychain / data directory. */
  oauthStore?: OAuthStore;
  /** Clock for token expiry; tests inject one. */
  now?: () => number;
  /**
   * The tool list may have changed: the server sent `notifications/tools/list_changed` (a push on the old
   * protocol, an event on the `subscriptions/listen` stream of the stateless one), or that stream dropped
   * and was opened again, so events may have been missed. The daemon refreshes its catalog on it. Runs on
   * the connection that received it; must not throw.
   */
  onToolsChanged?: () => void;
  /**
   * A warning for the person running the command (`warning: …` on stderr), e.g. a refreshed OAuth
   * login that could not be saved. Per-operation `onWarning` takes precedence. Each warning is
   * given once per session.
   */
  onWarning?: (message: string) => void;
  /**
   * What is known about the protocol this server spoke before this session connected (the catalog cache
   * remembers it). Only a stdio server is asked: see `McpSession.open`.
   */
  knownProtocol?: (server: ServerConfig) => ProtocolInfo | undefined;
  /**
   * The environment whose proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`) this session's HTTP
   * requests follow (config.md, "代理"): the CLI's in-process, the daemon's own in the daemon. Default: none,
   * so a library caller is never surprised by a proxy it did not ask for.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Where this server's log lines go (daemon.md "日志"): stdio stderr, connection and protocol events, one line per
   * call. Called once per session; absent: nothing is logged. Lines are redacted by the log.
   */
  log?: (server: ServerConfig) => ServerLog | undefined;
  /** Base of relative `roots` entries and the meaning of `~`: the CLI's working directory and home (config.md, `roots`). */
  roots?: { cwd: string; home: string };
}

const METHOD_NOT_FOUND = -32601;

/** An object with a string member `key`: the minimum a list entry needs to be usable. */
function hasString(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)[key] === 'string';
}

/** How the SDK's own progress notification for a round of `input_required` begins (it is not the tool's progress). */
const INPUT_ROUND = 'Fulfilling input required by';

/** Safety net against a server that keeps returning cursors. */
const MAX_LIST_PAGES = 1000;
/** How much of a stdio child's stderr we keep for error messages. */
const STDERR_KEEP = 4096;
/** Ceiling for the best-effort HTTP session termination on close. */
const TERMINATE_WAIT_MS = 1000;
/**
 * How long the `server/discover` probe of a stdio server may stay unanswered before it counts as a server
 * of the old protocol: some never answer a request that comes before `initialize`, and waiting out the
 * whole connect timeout would make every such server slow to start. HTTP has no such limit: silence there
 * is an outage, not an answer.
 */
const STDIO_PROBE_TIMEOUT_MS = 3000;
/** Delays between attempts to open the `subscriptions/listen` stream again after it dropped. */
const RELISTEN_FIRST_MS = 1000;
const RELISTEN_MAX_MS = 30_000;

/**
 * How the connection settles on a protocol version (config.md, `protocolVersion`; daemon.md, "协议版本与无状态连接").
 * Unpinned: newest first, automatically. The probe is `server/discover`; a server that answers it speaks the
 * stateless protocol, any other answer falls back to the `initialize` handshake on the same connection. A
 * stdio probe runs on a short-lived copy of the server process, so the real one starts once the protocol is
 * known (the SDK's choice; a server that dies on a request before `initialize` is then simply an old server).
 * Pinned: that version or an error. A stateless pin must be offered by the probe; an older pin is the
 * plain handshake that offers nothing else and rejects another counter-offer.
 */
function negotiation(pin: string | undefined, stdio: boolean): Pick<ClientOptions, 'versionNegotiation' | 'supportedProtocolVersions'> {
  const probe = stdio ? { timeoutMs: STDIO_PROBE_TIMEOUT_MS } : {};
  if (pin === undefined) return { versionNegotiation: { mode: 'auto', probe } };
  if (isModernProtocolVersion(pin)) return { versionNegotiation: { mode: { pin }, probe } };
  return { versionNegotiation: { mode: 'legacy' }, supportedProtocolVersions: [pin] };
}

/** A connection being made; `close()` abandons it. */
interface Attempt {
  aborted: boolean;
  controller: AbortController;
  client?: Client;
}

interface Handle {
  client: Client;
  /** Lifts the task a stateless server makes instead of a tool result out of the response (client/tasks.ts). */
  tasks: CreatedTaskShim;
  closed: boolean;
  /** What the handshake (or the probe) settled on. */
  protocol: ProtocolInfo;
  stderr: () => string;
  /** Process id of the stdio child. */
  pid?: () => number | null;
  terminate?: () => Promise<void>;
}

type Sdk = {
  Client: new (...args: ConstructorParameters<typeof import('@modelcontextprotocol/client').Client>) => Client & { readonly tasks: CreatedTaskShim };
};

let sdkPromise: Promise<Sdk> | undefined;

function loadSdk(): Promise<Sdk> {
  sdkPromise ??= import('@modelcontextprotocol/client').then(({ Client }) => {
    // The SDK has no runtime for tasks and its 2026 decoder rejects `resultType: "task"`: see CreatedTaskShim.
    class ViaClient extends Client {
      readonly tasks = new CreatedTaskShim();
      protected override _onresponse(response: Parameters<Client['_onresponse' & keyof Client]>[0]): void {
        super._onresponse(this.tasks.rewrite(response));
      }
    }
    return { Client: ViaClient };
  });
  return sdkPromise;
}

/**
 * Result "schema" that accepts anything. via sends requests through it instead of the SDK's typed
 * methods (`listTools()`, `readResource()`, …): those check every result against the full MCP schema
 * and fail the whole operation on one malformed entry, while via keeps what it can use (a list entry
 * with a `name`, a content with a `uri`) and renders the rest as the server sent it.
 */
const RAW: StandardSchemaV1<unknown, unknown> = {
  '~standard': { version: 1, vendor: 'via', validate: (value: unknown) => ({ value }) },
};

/**
 * The SDK's `callTool()` checks the result against the tool's `outputSchema` and throws when
 * `structuredContent` is missing, does not match, or the schema does not compile. via shows a result
 * as the server sent it and only warns about a mismatch (arguments.md, "输出校验"; done in the CLI),
 * so this provider hands the SDK no validator at all: with none, `callTool()` skips every check.
 */
const LENIENT_VALIDATOR = { getValidator: () => undefined } as unknown as NonNullable<ClientOptions['jsonSchemaValidator']>;

/**
 * A lazily connected session to one server. Operations are limited to `ServerConfig.concurrency`
 * at a time; the rest queue. A broken session is dropped and reconnected on the next operation.
 */
export class McpSession {
  private handle?: Handle;
  private connecting?: Promise<Handle>;
  private readonly limiter: Limiter;
  private oauth?: ViaOAuthProvider;
  /** Where warnings go: the operation that started last (the one that most likely caused it). */
  private warnSink?: (message: string) => void;
  private warnedSave = false;
  /** What the last connection of this session negotiated (kept across reconnects). */
  private lastProtocol?: ProtocolInfo;
  /** Abandons the connection being made (`close()` while connecting). */
  private abortConnect?: () => void;
  /** The calls running now that can be asked to answer a server's question, oldest first. */
  private readonly askers = new Set<{ sink: ElicitSink; left: () => number }>();
  private readonly log: ServerLog | undefined;

  constructor(
    readonly server: ServerConfig,
    private readonly resolver: CredentialResolver,
    private readonly options: SessionOptions = {},
  ) {
    this.limiter = new Limiter(server.concurrency);
    this.log = options.log?.(server);
  }

  /** Whether a live connection exists right now. */
  get connected(): boolean {
    return this.handle !== undefined && !this.handle.closed;
  }

  /** Process id of the running stdio child, if any. */
  get pid(): number | undefined {
    if (!this.handle || this.handle.closed) return undefined;
    return this.handle.pid?.() ?? undefined;
  }

  /** The negotiated protocol version and whether the connection is stateful; undefined while not connected. */
  protocol(): ProtocolInfo | undefined {
    return this.handle && !this.handle.closed ? this.handle.protocol : undefined;
  }

  /** `tools/list`, following `nextCursor` until the server stops returning one. */
  listTools(options: ListOptions = {}): Promise<McpTool[]> {
    return this.operate(options.timeoutMs ?? this.defaultTimeoutMs(), options.onWarning, (handle, left) =>
      this.pages<McpTool>(handle, 'tools/list', 'tools', left, (e): e is McpTool => hasString(e, 'name'), (page) => {
        const ttl = page.ttlMs;
        if (typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0) options.onTtl?.(ttl);
      }),
    );
  }

  /** What the server declared at `initialize`, once connected; undefined before the first connection. */
  features(): ServerFeatures | undefined {
    const capabilities = this.handle && !this.handle.closed ? this.handle.client.getServerCapabilities() : undefined;
    return capabilities ? { resources: capabilities.resources !== undefined, prompts: capabilities.prompts !== undefined, completions: capabilities.completions !== undefined, skills: this.skillsDeclared(capabilities) } : undefined;
  }

  /** Skills exist on a stateless-protocol connection to a server that declared the extension (ADR 0020). */
  private skillsDeclared(capabilities: { extensions?: Record<string, unknown> } | undefined): boolean {
    return this.handle?.client.getProtocolEra() === 'modern' && capabilities?.extensions?.[SKILLS_EXTENSION] !== undefined;
  }

  /** What the server says about itself (`serverInfo`, `instructions`), once connected; undefined before the first connection. */
  info(): ServerSelf | undefined {
    if (!this.handle || this.handle.closed) return undefined;
    return describeServer(this.handle.client.getServerVersion() as Record<string, unknown> | undefined, this.handle.client.getInstructions(), this.redactor());
  }

  /**
   * `completion/complete`: the server's suggestions for one argument of a prompt or resource template, given
   * what is typed so far and the other arguments as context. A server without the capability is refused
   * before any request. Suggestions are kept in the server's order (it sends at most 100).
   */
  complete(ref: CompletionRef, argument: { name: string; value: string }, context: Record<string, string> | undefined, options: ListOptions = {}): Promise<CompletionResult> {
    return this.operate(options.timeoutMs ?? this.defaultTimeoutMs(), undefined, async (handle, left) => {
      this.require(handle, 'completions');
      const params = { ref, argument, ...(context && Object.keys(context).length > 0 ? { context: { arguments: context } } : {}) };
      const raw = (await handle.client.request({ method: 'completion/complete', params }, RAW, { timeout: left() })) as { completion?: unknown };
      const completion = raw.completion as { values?: unknown; total?: unknown; hasMore?: unknown } | undefined;
      if (typeof completion !== 'object' || completion === null || !Array.isArray(completion.values)) throw new Error('completion/complete result has no "completion.values" array');
      return {
        values: completion.values.filter((v): v is string => typeof v === 'string'),
        ...(typeof completion.total === 'number' ? { total: completion.total } : {}),
        ...(typeof completion.hasMore === 'boolean' ? { hasMore: completion.hasMore } : {}),
      };
    });
  }

  /** `resources/list` and `resources/templates/list` (ADR 0010). A server without the capability is refused before any request. */
  listResources(options: ListOptions = {}): Promise<ResourceListing> {
    return this.operate(options.timeoutMs ?? this.defaultTimeoutMs(), undefined, async (handle, left) => {
      this.require(handle, 'resources');
      const resources = await this.pages<ResourceListing['resources'][number]>(handle, 'resources/list', 'resources', left, (e): e is ResourceListing['resources'][number] => hasString(e, 'uri'));
      // Templates are optional even for a server with resources: "method not found" means none.
      const templates = await this.pages<ResourceListing['templates'][number]>(handle, 'resources/templates/list', 'resourceTemplates', left, (e): e is ResourceListing['templates'][number] => hasString(e, 'uriTemplate')).catch((err: unknown) => {
        if ((err as { code?: unknown } | null)?.code === METHOD_NOT_FOUND) return [];
        throw err;
      });
      return { resources, templates };
    });
  }

  /** `resources/read`. An unknown or unreadable URI is a "not found" (exit code 3). */
  readResource(uri: string, options: ListOptions = {}): Promise<ReadResourceResult> {
    return this.operate(options.timeoutMs ?? this.defaultTimeoutMs(), undefined, async (handle, left) => {
      this.require(handle, 'resources');
      const raw = await handle.client.request({ method: 'resources/read', params: { uri } }, RAW, { timeout: left() }).catch((err: unknown) => {
        throw resourceNotFound(err, uri, this.server.provider, this.redactor()) ?? err;
      });
      const contents = (raw as { contents?: unknown }).contents;
      if (!Array.isArray(contents)) throw new Error('resources/read result has no "contents" array');
      return { contents: contents.filter((c): c is ReadResourceResult['contents'][number] => hasString(c, 'uri')) };
    });
  }

  /** `prompts/list`, following `nextCursor`. */
  listPrompts(options: ListOptions = {}): Promise<McpPrompt[]> {
    return this.operate(options.timeoutMs ?? this.defaultTimeoutMs(), undefined, async (handle, left) => {
      this.require(handle, 'prompts');
      return this.pages<McpPrompt>(handle, 'prompts/list', 'prompts', left, (e): e is McpPrompt => hasString(e, 'name'));
    });
  }

  /** `prompts/get`. The server rejecting the arguments surfaces like a tool doing so (exit code 1). */
  getPrompt(name: string, args: Record<string, string>, options: ListOptions = {}): Promise<GetPromptResult> {
    return this.operate(options.timeoutMs ?? this.defaultTimeoutMs(), undefined, async (handle, left) => {
      this.require(handle, 'prompts');
      const raw = await handle.client.request({ method: 'prompts/get', params: { name, arguments: args } }, RAW, { timeout: left() });
      const messages = (raw as { messages?: unknown }).messages;
      if (!Array.isArray(messages)) throw new Error('prompts/get result has no "messages" array');
      const description = (raw as { description?: unknown }).description;
      return {
        ...(typeof description === 'string' ? { description } : {}),
        messages: messages.filter((m): m is GetPromptResult['messages'][number] => hasString(m, 'role') && typeof (m as { content?: unknown }).content === 'object'),
      };
    });
  }

  /**
   * `skills/list`, following the pages: every skill with its manifest. An entry the extension does not allow a
   * client to use (no `SKILL.md` URI, no `name`/`description`, no manifest) is left out, and said so once.
   */
  listSkills(options: ListOptions = {}): Promise<SkillEntry[]> {
    return this.operate(options.timeoutMs ?? this.defaultTimeoutMs(), options.onWarning, async (handle, left) => {
      this.requireSkills(handle);
      const raw = await this.pages<Record<string, unknown>>(handle, 'skills/list', 'skills', left, (e): e is Record<string, unknown> => typeof e === 'object' && e !== null);
      const skills = raw.map(parseSkillEntry).filter((e): e is SkillEntry => e !== undefined);
      if (skills.length < raw.length) this.warn(`${raw.length - skills.length} skill entr${raw.length - skills.length === 1 ? 'y' : 'ies'} of ${this.server.provider} ignored: the extension requires a URI, a name, a description and a manifest`);
      return skills;
    });
  }

  /**
   * One file of one skill, checked before it is handed over: `skills/get` for the current entry, `resources/read` for
   * the file (`file` is a name relative to the skill's directory, none for `SKILL.md`), then size and sha256 against
   * the manifest. Anything that does not match is refused, never returned.
   */
  readSkill(skillUri: string, file: string | undefined, options: ListOptions = {}): Promise<SkillRead> {
    return this.operate(options.timeoutMs ?? this.defaultTimeoutMs(), options.onWarning, async (handle, left) => {
      this.requireSkills(handle);
      const redact = this.redactor();
      const got = (await handle.client.request({ method: 'skills/get', params: { uri: skillUri } }, RAW, { timeout: left() }).catch((err: unknown) => {
        if (isNotFoundCode(err)) throw skillNotFound(this.server, `no such skill: ${skillUri}`, redact);
        throw err;
      })) as { skill?: unknown };
      const skill = parseSkillEntry(got.skill);
      if (!skill) throw new Error('skills/get returned an entry without a URI, a name, a description or a manifest');
      const choice = chooseFile(skill, file);
      if ('problem' in choice) {
        const named = skill.frontmatter.name;
        if (choice.problem === 'unlisted') throw skillNotFound(this.server, `skill ${named} has no file ${file}`, redact, choice.files);
        throw new ClientError({ exitCode: 2, message: choice.problem === 'empty' ? 'the file name is empty' : `the file name ${file} leaves the skill's directory (..)`, next: `via skills ${this.server.provider} ${named}` });
      }
      const read = (await handle.client.request({ method: 'resources/read', params: { uri: choice.uri } }, RAW, { timeout: left() }).catch((err: unknown) => {
        throw resourceNotFound(err, choice.uri, this.server.provider, redact) ?? err;
      })) as { contents?: unknown };
      const contents = Array.isArray(read.contents) ? read.contents.filter((c): c is Record<string, unknown> => hasString(c, 'uri')) : [];
      const item = contents.find((c) => c.uri === choice.uri) ?? contents[0];
      const bytes = item ? contentBytes(item) : undefined;
      if (!item || !bytes) throw skillRefused(this.server, choice.uri, 'the server returned no text or blob for it', redact);
      const problem = verifyFile(skill, choice.uri, bytes);
      if (problem) throw skillRefused(this.server, choice.uri, problem, redact);
      return {
        skill,
        file: { uri: choice.uri, ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}), ...(typeof item.text === 'string' ? { text: item.text } : {}), ...(typeof item.blob === 'string' ? { blob: item.blob } : {}) },
        verified: skill.resources !== 'dynamic',
      };
    });
  }

  /** Skills need the stateless protocol and the extension declared by the server; nothing is sent otherwise. */
  private requireSkills(handle: Handle): void {
    if (handle.client.getProtocolEra() !== 'modern') throw noSkills(this.server, { protocol: handle.protocol.version || 'before 2026-07-28' });
    if ((handle.client.getServerCapabilities() as { extensions?: Record<string, unknown> } | undefined)?.extensions?.[SKILLS_EXTENSION] === undefined) throw noSkills(this.server, { extension: SKILLS_EXTENSION });
  }

  /**
   * `tools/call`; returns the server's result untouched (`isError` included). When the call became a task (the server
   * decided so on the stateless protocol; on the old one, because the tool requires it) the task is followed to its
   * end within the same budget and its result returned as if the call had been synchronous (cli.md, "任务").
   */
  callTool(rawName: string, args: Record<string, unknown> | undefined, options: CallOptions = {}): Promise<ToolCallResult> {
    return this.runCall(rawName, args, options, false).then((done) => {
      if ('result' in done) return done.result;
      throw new Error('a followed call ended as a task'); // unreachable: following ends in a result or an error
    });
  }

  /** `tools/call` that returns as soon as the server made a task (`--detach`); the result when it made none. */
  detachTool(rawName: string, args: Record<string, unknown> | undefined, options: CallOptions = {}): Promise<DetachedCall> {
    return this.runCall(rawName, args, options, true);
  }

  private runCall(rawName: string, args: Record<string, unknown> | undefined, options: CallOptions, detach: boolean): Promise<DetachedCall> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs();
    const began = Date.now();
    let deadline = began + timeoutMs;
    const left = (): number => Math.max(1, deadline - Date.now());
    return this.limiter.run(async () => {
      if (options.onWarning) this.warnSink = options.onWarning;
      // While this call runs, the server may ask the person behind it something (elicitation, ADR 0018).
      const asker = options.elicit ? { sink: options.elicit, left } : undefined;
      if (asker) this.askers.add(asker);
      let made: TaskInfo | undefined;
      const attempt = async (): Promise<DetachedCall> => {
        const handle = await this.ensureConnected(left(), timeoutMs);
        return this.request(handle, 'request', timeoutMs, async () => {
          const started = await this.startCall(handle, rawName, args, options, detach, left, asker);
          if ('result' in started) return started;
          made = started.task;
          options.onTask?.(started.task);
          if (detach) return started;
          const outcome = await this.waitTask(handle, { task: started.task, fresh: false }, left, timeoutMs, true);
          return { result: outcome.result! };
        });
      };
      try {
        return await attempt();
      } catch (err) {
        // A call that became a task is not sent again: that would run the job twice.
        if (made || !(options.retry && err instanceof ClientError && err.retryable)) throw err;
        await this.drop();
        deadline = Date.now() + timeoutMs; // the retry has a budget of its own
        return attempt();
      } finally {
        if (asker) this.askers.delete(asker);
      }
    }, this.queueWait(timeoutMs)).then(
      (done) => {
        // A call detached from the task it made has no result yet; the task's own calls are logged by whoever follows it.
        this.log?.event(`call ${rawName} ${'task' in done ? 'became a task' : done.result.isError ? 'returned isError' : 'ok'} in ${Date.now() - began}ms`);
        return done;
      },
      (err: unknown) => {
        const failure = err instanceof ClientError ? `exit ${err.exitCode}: ${firstLine(err.message)}` : 'failed';
        this.log?.error(`call ${rawName} failed in ${Date.now() - began}ms (${failure})`);
        throw err;
      },
    );
  }

  /** Send `tools/call` and sort the answer into a result or a created task. */
  private async startCall(handle: Handle, rawName: string, args: Record<string, unknown> | undefined, options: CallOptions, detach: boolean, left: () => number, asker: { sink: ElicitSink; left: () => number } | undefined): Promise<DetachedCall> {
    const modern = handle.client.getProtocolEra() === 'modern';
    const capabilities = handle.client.getServerCapabilities() as { tasks?: { requests?: { tools?: { call?: unknown } } }; extensions?: Record<string, unknown> } | undefined;
    // The old protocol: the client asks for a task, for a tool that requires one or when detaching, if the server and the tool allow it.
    let ask = false;
    if (!modern) {
      const supported = capabilities?.tasks?.requests?.tools?.call !== undefined;
      const toolSays = options.taskSupport;
      if (detach) {
        if (!supported) throw cannotDetach(this.server, `${this.server.provider} did not declare support for tasks on tool calls`);
        if (toolSays !== undefined && toolSays !== 'optional' && toolSays !== 'required') throw cannotDetach(this.server, `the tool declares no task support (execution.taskSupport: ${toolSays})`);
        ask = true;
      } else ask = toolSays === 'required' && supported;
    } else if (detach && capabilities?.extensions?.[TASKS_EXTENSION] === undefined) {
      throw cannotDetach(this.server, `${this.server.provider} did not declare the ${TASKS_EXTENSION} extension`);
    }
    const params = { name: rawName, arguments: args ?? {}, ...(ask ? { task: {} } : {}) };
    // On the stateless protocol the SDK reports each round of answering the server's questions (roots,
    // elicitation) as a progress notification of its own; that is not the tool's progress.
    const onprogress = options.onProgress;
    const send = onprogress ? { onprogress: (p: Parameters<NonNullable<CallOptions['onProgress']>>[0]) => (p.message?.startsWith(INPUT_ROUND) ? undefined : onprogress(p)) } : {};
    // The stateless protocol has the SDK mirror tool arguments the tool declared with `x-mcp-header`
    // into request headers (a server refuses the call without them); on the old protocol the result
    // is taken as the server sent it.
    const send1 = async (): Promise<unknown> =>
      modern ? handle.client.callTool(params, { ...send, timeout: left() }) : handle.client.request({ method: 'tools/call', params }, RAW, { ...send, timeout: left() });
    let raw: unknown;
    try {
      raw = await send1();
    } catch (err) {
      // `URLElicitationRequired`: the server wants the person at a web page first, then the call again.
      if (!(await this.visitedUrls(err, asker))) throw err;
      raw = await send1();
    }
    if (typeof raw !== 'object' || raw === null) throw new Error('tools/call returned a non-object result');
    const lifted = modern ? handle.tasks.take(raw) : ask && 'task' in raw ? raw : undefined;
    if (lifted === undefined) return { result: raw as ToolCallResult };
    const task = readTask(lifted);
    if (!task) throw new Error('tools/call answered with a task that has no valid id and status');
    return { task };
  }

  // Tasks ---------------------------------------------------------------------------------------

  /** Tasks need the capability (old protocol) or the extension (stateless protocol) declared by the server; nothing is sent otherwise. */
  private requireTasks(handle: Handle): void {
    const capabilities = handle.client.getServerCapabilities() as { tasks?: unknown; extensions?: Record<string, unknown> } | undefined;
    if (handle.client.getProtocolEra() === 'modern') {
      if (capabilities?.extensions?.[TASKS_EXTENSION] === undefined) throw noTasks(this.server, `it did not declare the ${TASKS_EXTENSION} extension`);
    } else if (capabilities?.tasks === undefined) throw noTasks(this.server, 'it did not declare the tasks capability');
  }

  /** `tasks/get`: the task as the server describes it now, and the raw answer (the stateless protocol inlines the result in it). */
  private async fetchTask(handle: Handle, id: string, left: () => number): Promise<{ task: TaskInfo; raw: unknown }> {
    const raw = await handle.client.request({ method: 'tasks/get', params: { taskId: id } } as never, RAW, { timeout: left() }).catch((err: unknown) => {
      if (isNotFoundCode(err)) throw taskNotFound(this.server, id, this.redactor());
      throw err;
    });
    const task = readTask(raw);
    if (!task) throw new Error('tasks/get answered with something that is not a task');
    return { task, raw };
  }

  /**
   * Follow a task until it ends or `left()` runs out: ask at the pace the server suggests, then take the result from where
   * the generation keeps it (`tasks/result` on the old protocol, inline in `tasks/get` on the stateless one). A failed or
   * cancelled task gives an error result, as a failing tool would. A task that waits for input stops the wait: `follow`
   * (a call) turns that into an error, the task commands report the state. Running out of time is an error that names the
   * task and does not cancel it.
   */
  private async waitTask(handle: Handle, initial: { task: TaskInfo; raw?: unknown; fresh: boolean }, left: () => number, timeoutMs: number, follow: boolean): Promise<TaskOutcome> {
    const modern = handle.client.getProtocolEra() === 'modern';
    let { task, raw, fresh } = initial;
    // On the old protocol the status of a created task can be acted on at once; on the stateless one the answer to `tools/call`
    // never carries the outcome, so a task that is already over still needs its `tasks/get`.
    if (!modern) fresh = true;
    const seconds = String(Math.round(timeoutMs / 100) / 10);
    for (;;) {
      if (task.status === 'input_required') {
        if (follow) throw taskNeedsInput(this.server, task.id, task.inputMethods ?? [], this.redactor());
        return { task };
      }
      if (isTerminal(task.status) && fresh) break;
      if (!isTerminal(task.status)) {
        if (left() <= 1) throw taskStillRunning(this.server, task.id, seconds, this.redactor());
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollDelay(task), left())));
        if (left() <= 1) throw taskStillRunning(this.server, task.id, seconds, this.redactor());
      }
      ({ task, raw } = await this.fetchTask(handle, task.id, left));
      fresh = true;
    }
    const failure = (text: string): ToolCallResult => ({ content: [{ type: 'text', text }], isError: true });
    if (task.status === 'completed') {
      const result = modern
        ? inlineResult(raw)
        : ((await handle.client.request({ method: 'tasks/result', params: { taskId: task.id } } as never, RAW, { timeout: left() }).catch((err: unknown) => {
            if (isNotFoundCode(err)) throw taskNotFound(this.server, task.id, this.redactor());
            throw err;
          })) as Record<string, unknown>);
      if (typeof result !== 'object' || result === null) throw new Error('the task completed without a result');
      return { task, result: result as ToolCallResult };
    }
    const why = task.error ?? task.message;
    return { task, result: failure(task.status === 'cancelled' ? `task was cancelled${why ? `: ${why}` : ''}` : (why ?? 'task failed')) };
  }

  /** `tasks/get` for a task id. */
  getTask(taskId: string, options: ListOptions = {}): Promise<TaskInfo> {
    return this.operate(options.timeoutMs ?? this.defaultTimeoutMs(), undefined, async (handle, left) => {
      this.requireTasks(handle);
      return (await this.fetchTask(handle, taskId, left)).task;
    });
  }

  /** Wait for a task to end (within the timeout) and return it with its result (cli.md, "任务"). */
  waitForTask(taskId: string, options: ListOptions = {}): Promise<TaskOutcome> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs();
    return this.operate(timeoutMs, undefined, async (handle, left) => {
      this.requireTasks(handle);
      const first = await this.fetchTask(handle, taskId, left);
      return this.waitTask(handle, { ...first, fresh: true }, left, timeoutMs, false);
    });
  }

  /**
   * Ask the server to cancel a task and report what it says afterwards. The stateless extension only acknowledges (the
   * task may stay `working`), so the state is fetched; a task that already ended is reported as it is.
   */
  cancelTask(taskId: string, options: ListOptions = {}): Promise<TaskInfo> {
    return this.operate(options.timeoutMs ?? this.defaultTimeoutMs(), undefined, async (handle, left) => {
      this.requireTasks(handle);
      const modern = handle.client.getProtocolEra() === 'modern';
      try {
        const raw = await handle.client.request({ method: 'tasks/cancel', params: { taskId } } as never, RAW, { timeout: left() });
        const answered = modern ? undefined : readTask(raw);
        if (answered) return answered;
      } catch (err) {
        if (!isNotFoundCode(err)) throw err;
        // Unknown, or already over (the old protocol refuses to cancel an ended task): the state tells which.
      }
      return (await this.fetchTask(handle, taskId, left)).task;
    });
  }

  /** `tasks/list` (old protocol, when the server declared `tasks.list`), all pages; no tasks when the server has no listing. */
  listTasks(options: ListOptions = {}): Promise<TaskList> {
    return this.operate(options.timeoutMs ?? this.defaultTimeoutMs(), undefined, async (handle, left) => {
      this.requireTasks(handle);
      const tasks = (handle.client.getServerCapabilities() as { tasks?: { list?: unknown } } | undefined)?.tasks;
      if (handle.client.getProtocolEra() === 'modern' || tasks?.list === undefined) return {};
      const raw = await this.pages<Record<string, unknown>>(handle, 'tasks/list', 'tasks', left, (e): e is Record<string, unknown> => typeof e === 'object' && e !== null);
      return { tasks: raw.map(readTask).filter((t): t is TaskInfo => t !== undefined) };
    });
  }

  /**
   * Close the session and kill the stdio child, if any. A connection still being made is abandoned
   * (its child killed) rather than waited for: a server that hangs in its handshake must not hold
   * up a daemon that is stopping. Safe to call repeatedly.
   */
  async close(): Promise<void> {
    const pending = this.connecting;
    if (pending) {
      this.abortConnect?.();
      await pending.catch(() => undefined);
    }
    await this.drop();
    await this.log?.flush();
  }

  // Internals ---------------------------------------------------------------------------------

  /**
   * One operation within one budget of `timeoutMs`: the wait for a free slot (`concurrency`), for the
   * connection, and every request it sends all count against it (`left` is what remains). A server
   * that hangs in its handshake (the connection itself may take the server's own `timeout`) or sits
   * behind a long call then fails this operation in time, instead of holding its caller (a CLI
   * waiting on the daemon) for as long as the slowest step takes.
   */
  private operate<T>(timeoutMs: number, onWarning: ((message: string) => void) | undefined, fn: (handle: Handle, left: () => number) => Promise<T>): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    const left = (): number => Math.max(1, deadline - Date.now());
    return this.limiter.run(async () => {
      if (onWarning) this.warnSink = onWarning;
      const handle = await this.ensureConnected(left(), timeoutMs);
      return this.request(handle, 'request', timeoutMs, () => fn(handle, left));
    }, this.queueWait(timeoutMs));
  }

  /** How long an operation may wait for a slot: its whole budget; it then fails as a timeout. */
  private queueWait(timeoutMs: number): { ms: number; error: () => Error } {
    return { ms: timeoutMs, error: () => timedOut(this.server, 'request', timeoutMs) };
  }

  /** Follow `nextCursor` of a list method and collect `key` from every page; `left` is the time remaining. */
  private async pages<T>(handle: Handle, method: string, key: string, left: () => number, keep: (entry: unknown) => entry is T, first?: (page: Record<string, unknown>) => void): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const raw = (await handle.client.request({ method, params: cursor === undefined ? {} : { cursor } }, RAW, { timeout: left() })) as Record<string, unknown>;
      if (page === 0) first?.(raw);
      const entries = raw[key];
      if (!Array.isArray(entries)) throw new Error(`${method} result has no "${key}" array`);
      for (const entry of entries) if (keep(entry)) items.push(entry);
      const next = (raw as { nextCursor?: unknown }).nextCursor;
      if (typeof next !== 'string' || next === '') return items;
      if (seen.has(next)) throw new Error(`${method} returned the same cursor twice`);
      seen.add(next);
      cursor = next;
    }
    throw new Error(`${method} did not finish after ${MAX_LIST_PAGES} pages`);
  }

  /** Refuse a request the server did not declare support for, instead of sending it. */
  private require(handle: Handle, feature: 'resources' | 'prompts' | 'completions'): void {
    if (handle.client.getServerCapabilities()?.[feature] === undefined) throw noFeature(this.server, feature);
  }

  private defaultTimeoutMs(): number {
    return this.server.timeout * 1000;
  }

  private redactor(): (text: string) => string {
    return createRedactor(this.resolver.resolvedValues());
  }

  /** Run `fn`, mapping any failure to a ClientError. */
  private async request<T>(handle: Handle, phase: Phase, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw mapError(err, {
        server: this.server,
        phase,
        timeoutMs,
        redact: this.redactor(),
        stderrTail: handle.stderr(),
      });
    }
  }

  /**
   * The live connection, made on first use and shared by every operation. An operation waits for it
   * at most `waitMs` and then fails as a connect timeout of `timeoutMs`; the connection attempt itself
   * goes on (up to the server's `timeout`), so the next operation may find it ready.
   */
  private ensureConnected(waitMs: number, timeoutMs: number): Promise<Handle> {
    if (this.handle && !this.handle.closed) return Promise.resolve(this.handle);
    this.handle = undefined;
    this.connecting ??= this.connect().then(
      (handle) => {
        this.handle = handle;
        this.connecting = undefined;
        return handle;
      },
      (err: unknown) => {
        this.connecting = undefined;
        throw err;
      },
    );
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timedOut(this.server, 'connect', timeoutMs)), waitMs);
    });
    return Promise.race([this.connecting, late]).finally(() => clearTimeout(timer));
  }

  private connect(): Promise<Handle> {
    const attempt: Attempt = { aborted: false, controller: new AbortController() };
    const abort = (): void => {
      attempt.aborted = true;
      attempt.controller.abort(); // ends a protocol probe in progress (the SDK would otherwise finish it first)
      void attempt.client?.close().catch(() => undefined); // kills a half-started child
    };
    this.abortConnect = abort;
    return this.open(attempt).finally(() => {
      if (this.abortConnect === abort) this.abortConnect = undefined;
    });
  }

  private async open(attempt: Attempt): Promise<Handle> {
    const { server } = this;
    // Checks that must pass before anything is spawned or sent.
    if (server.disabled) throw notFoundServer(server.name, []);
    if (!server.trusted) throw untrustedServer(server);

    const timeoutMs = this.defaultTimeoutMs();
    let resolved: ResolvedConnection;
    let authFetch: FetchLike | undefined;
    try {
      resolved = await resolveConnection(server, this.resolver);
      // Without a saved login this fails right here, before any request (auth.md, "调用时的行为").
      if (server.auth.type === 'oauth') authFetch = await this.oauthFetch();
    } catch (err) {
      throw mapError(err, { server, phase: 'connect', timeoutMs, redact: this.redactor() });
    }

    // Probing a stdio server starts it twice (the SDK probes a copy), which is slow for a server that
    // takes seconds to start and wrong for one with side effects at startup. So a stdio server that was
    // last seen speaking the old protocol is connected with the plain handshake and no probe; if that
    // fails for a reason other than a timeout, it is tried once more with the probe (it may have moved on).
    const known = resolved.type === 'stdio' && server.protocolVersion === undefined ? (this.lastProtocol ?? this.options.knownProtocol?.(server)) : undefined;
    const skipProbe = known !== undefined && known.version !== '' && !isModernProtocolVersion(known.version);
    try {
      return await this.establish(attempt, resolved, authFetch, skipProbe);
    } catch (err) {
      if (!skipProbe || attempt.aborted || !(err instanceof ClientError) || err.retryable) throw err;
      this.log?.event('the plain handshake failed; trying again with the protocol probe');
      return this.establish(attempt, resolved, authFetch, false);
    }
  }

  /** Make the client and its transport and connect them: one try, `legacy` meaning "plain handshake, no probe". */
  private async establish(attempt: Attempt, resolved: ResolvedConnection, authFetch: FetchLike | undefined, legacy: boolean): Promise<Handle> {
    const { server } = this;
    const timeoutMs = this.defaultTimeoutMs();
    let stderrBuf = '';
    let client: (Client & { readonly tasks: CreatedTaskShim }) | undefined;
    let handle: Handle | undefined;
    const began = Date.now();
    this.log?.event(
      `${resolved.type === 'stdio' ? `starting ${programOf(resolved.command)}` : `connecting to ${originOf(resolved.url)}`}; protocol: ${server.protocolVersion !== undefined ? `pinned to ${server.protocolVersion}` : legacy ? 'plain handshake, no probe (last seen on the old protocol)' : 'newest first (server/discover, then initialize)'}`,
    );
    try {
      const { Client: ClientCtor } = await loadSdk();
      // The `roots` capability is declared only when the server has roots configured (ADR 0010), and
      // never as `listChanged`: the roots of a session do not change during its life.
      const roots = resolveRoots(server.roots, this.options.roots ?? { cwd: process.cwd(), home: process.env.HOME ?? '' });
      const changed = this.options.onToolsChanged;
      const onToolsChanged = changed
        ? (): void => {
            this.log?.event('the tool list changed (list_changed)');
            changed();
          }
        : undefined;
      client = new ClientCtor(
        { name: 'via', version: pkg.version },
        {
          // `elicitation` is always declared (ADR 0018): a question is answered by the person at the terminal that made
          // the call, or declined; `sampling` never is, since via does not call a model.
          // `tasks` is declared on every request: a stateless server may only make a task for a client that did, and via follows it (ADR 0020).
          capabilities: { elicitation: ELICITATION_CAPABILITY, ...(roots.length > 0 ? { roots: { listChanged: false } } : {}), extensions: { [TASKS_EXTENSION]: {} } },
          jsonSchemaValidator: LENIENT_VALIDATOR,
          ...negotiation(server.protocolVersion, resolved.type === 'stdio'),
          // Only a signal: via lists again itself (the daemon's catalog refresh), not the SDK.
          ...(onToolsChanged ? { listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => onToolsChanged() } } } : {}),
        },
      );
      attempt.client = client;
      if (roots.length > 0) client.setRequestHandler('roots/list', () => ({ roots }));
      client.setRequestHandler('elicitation/create', (request) => this.onElicit(request.params));
      let transport: Transport;
      let terminate: (() => Promise<void>) | undefined;
      let pid: (() => number | null) | undefined;
      let sessionId: (() => string | undefined) | undefined;

      if (resolved.type === 'stdio') {
        const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
        // Windows: PATH/PATHEXT lookup that never looks in the working directory, `.cmd` shims checked
        // for arguments `cmd.exe` cannot carry (platform/command.ts). A no-op elsewhere.
        const prepared = prepareStdioCommand(resolved.command, resolved.args, { env: resolved.env, cwd: resolved.cwd ?? process.cwd(), platform: process.platform });
        if (!prepared.ok) throw Object.assign(new Error(prepared.message), { code: prepared.code });
        const stdio = new StdioClientTransport({
          command: prepared.command,
          args: resolved.args,
          env: resolved.env,
          ...(resolved.cwd !== undefined ? { cwd: resolved.cwd } : {}),
          stderr: 'pipe',
        });
        // Child stderr is never forwarded: it could echo credentials. Keep a tail for error messages.
        stdio.stderr?.on('data', (chunk: Buffer | string) => {
          stderrBuf = (stderrBuf + chunk.toString()).slice(-STDERR_KEEP);
          this.log?.stderr(chunk.toString());
        });
        pid = () => stdio.pid;
        transport = stdio;
      } else {
        let url: URL;
        try {
          url = new URL(resolved.url);
        } catch {
          throw internal(`invalid url for ${server.provider}: not a URL`);
        }
        const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
        // Through the proxy the environment asks for, if any; the OAuth fetch (made in `oauthFetch`) wraps the same one.
        const send = authFetch ?? this.proxied();
        const http = new StreamableHTTPClientTransport(url, { requestInit: { headers: resolved.headers }, ...(send ? { fetch: send } : {}) });
        terminate = () => http.terminateSession();
        sessionId = () => http.sessionId;
        transport = http;
      }

      const created: Handle = { client, tasks: client.tasks, closed: false, protocol: { version: '', stateful: false }, stderr: () => stderrBuf, ...(pid ? { pid } : {}), ...(terminate ? { terminate } : {}) };
      handle = created;
      client.onclose = () => {
        if (!created.closed) this.log?.event('connection closed');
        created.closed = true;
      };
      if (attempt.aborted) throw new Error('the session was closed while connecting');
      await client.connect(transport, { timeout: timeoutMs, signal: attempt.controller.signal, ...(legacy ? { prior: { kind: 'legacy' as const } } : {}) });
      const modern = client.getProtocolEra() === 'modern';
      // A stdio process is a session of its own; an HTTP server of the old protocol has one if it handed out an id.
      created.protocol = { version: client.getNegotiatedProtocolVersion() ?? '', stateful: !modern && (resolved.type === 'stdio' || sessionId?.() !== undefined) };
      if (onToolsChanged) this.watchListen(created, client.autoOpenedSubscription);
      this.lastProtocol = created.protocol;
      this.log?.event(`connected in ${Date.now() - began}ms; protocol ${created.protocol.version || 'unknown'}, ${created.protocol.stateful ? 'stateful' : 'stateless'}${pid?.() ? `; pid ${pid()}` : ''}`);
      return created;
    } catch (err) {
      const mapped = mapError(err, { server, phase: 'connect', timeoutMs, redact: this.redactor(), stderrTail: stderrBuf });
      this.log?.error(`connect failed after ${Date.now() - began}ms: ${firstLine(mapped.message)}`);
      if (client) await client.close().catch(() => undefined); // kills a half-started child
      if (handle) handle.closed = true;
      throw mapped;
    }
  }

  /**
   * On the stateless protocol list changes arrive on a `subscriptions/listen` stream the SDK opened at
   * connect. The SDK never opens it again after a drop, and without it the catalog would silently stop
   * following the server, so a stream that ends without the server saying goodbye is opened again with a
   * growing delay (1 s to 30 s), and the daemon is told to refresh: events may have been missed meanwhile.
   */
  private watchListen(handle: Handle, subscription: McpSubscription | undefined): void {
    if (!subscription) return;
    void subscription.closed.then((reason) => {
      if (reason === 'remote' && !handle.closed) void this.relisten(handle, subscription.honoredFilter);
    });
  }

  private async relisten(handle: Handle, filter: SubscriptionFilter): Promise<void> {
    let delay = RELISTEN_FIRST_MS;
    while (!handle.closed) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay).unref());
      if (handle.closed) return;
      try {
        const next = await handle.client.listen(filter, { timeout: this.defaultTimeoutMs() });
        if (handle.closed) {
          await next.close().catch(() => undefined);
          return;
        }
        this.watchListen(handle, next);
        this.options.onToolsChanged?.();
        return;
      } catch {
        delay = Math.min(delay * 2, RELISTEN_MAX_MS);
        this.log?.event(`the list_changed stream is down; trying again in ${Math.round(delay / 1000)}s`);
      }
    }
  }

  /**
   * A fetch that attaches the OAuth access token and refreshes it when due. The provider outlives
   * reconnects: a long-lived session (a daemon's) keeps refreshing through it.
   */
  private async oauthFetch(): Promise<FetchLike> {
    if (!this.oauth) {
      const { createCallProvider, createOAuthStore } = await import('./oauth');
      const track = (value: string): void => this.resolver.track?.(value);
      this.oauth = createCallProvider(this.server, this.options.oauthStore ?? createOAuthStore(), {
        track,
        resolveCredential: (ref) => this.resolver.resolve(ref, this.server.origin),
        ...(this.proxied() ? { fetch: this.proxied()! } : {}),
        ...(this.options.now ? { now: this.options.now } : {}),
        onSaveFailed: (reason) => {
          if (this.warnedSave) return;
          this.warnedSave = true;
          this.warn(
            `could not save the refreshed OAuth login for ${this.server.provider} (${reason}); the new token is used for now, but a server that rotates refresh tokens will ask for a new login. Make the login store writable (via doctor)`,
          );
        },
      });
    }
    await this.oauth.requireLogin();
    return this.oauth.createFetch(this.proxied());
  }

  /** A `fetch` through the configured proxy, or undefined when the environment names none. */
  private proxied(): FetchLike | undefined {
    return this.options.env ? proxyFetch(this.options.env, { track: (value) => this.resolver.track?.(value) }) : undefined;
  }

  private warn(message: string): void {
    (this.warnSink ?? this.options.onWarning)?.(message);
  }

  // Elicitation -------------------------------------------------------------------------------

  /**
   * The server asks the person for input. The question goes to the oldest running call that can be asked
   * (the protocol does not say which call a question belongs to), or is declined here with a warning when
   * there is none. The server's text is redacted first.
   */
  private async onElicit(params: unknown): Promise<ElicitAnswer> {
    const redact = this.redactor();
    const question = parseQuestion(redactValue(params, (text) => redact(text)), this.server.provider);
    if (!question) return { action: 'decline' };
    const asker = this.askers.values().next().value;
    if (!asker) {
      this.warn(`${this.server.provider} asked for user input outside of a tool call; it was declined`);
      return { action: 'decline' };
    }
    return this.askPerson(asker, question);
  }

  private async askPerson(asker: { sink: ElicitSink; left: () => number }, question: ElicitQuestion): Promise<ElicitAnswer> {
    let answer: ElicitAnswer;
    try {
      answer = parseAnswer(await asker.sink.ask({ ...question, timeLeftMs: asker.left() }));
    } catch {
      answer = { action: 'cancel' };
    }
    // The kind of question and what became of it, never its text or the answer.
    this.log?.event(`user input asked (${describeQuestion(question)}): ${answer.action}`);
    return answer;
  }

  /**
   * `err` is `URLElicitationRequired` (2025-11-25) and the person visited every page it names, so the call can
   * be made again. False for any other error, with nobody to ask, or when the person declined or cancelled.
   */
  private async visitedUrls(err: unknown, asker: { sink: ElicitSink; left: () => number } | undefined): Promise<boolean> {
    const urls = urlElicitationsOf(err);
    if (!urls || !asker) return false;
    const redact = this.redactor();
    for (const wanted of urls) {
      const question = parseQuestion({ mode: 'url', message: redact(wanted.message), url: redact(wanted.url) }, this.server.provider);
      if (question?.mode !== 'url') return false;
      const answer = await this.askPerson(asker, { ...question, retry: true });
      if (answer.action !== 'accept') return false;
    }
    return true;
  }

  /** Tear down the current connection (if any). */
  private async drop(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    if (!handle) return;
    handle.closed = true;
    if (handle.terminate) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        handle.terminate().catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, TERMINATE_WAIT_MS);
          timer.unref();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    await handle.client.close().catch(() => undefined);
  }
}

/** The first line of a message, at most 300 characters. */
function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}
