// The daemon (daemon.md): a unix-socket (Windows: named pipe) server that keeps MCP sessions, tool lists, resolved
// credentials and truncation cursors for every `via` process of one user. The CLI parses arguments
// and renders; the daemon answers with structured results.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import type { JsonSchema } from '../catalog/types';
import { compileSchema, type CompileResult } from '../schema/validate';
import { ClientError } from '../client';
import { parseAnswer, type ElicitAnswer, type ElicitQuestion, type ElicitSink } from '../client/elicit';
import type { OAuthStore } from '../client/oauth';
import { createCredentialResolver } from '../config/credentials';
import { pathContext, userCacheDir } from '../config/paths';
import type {
  CompletionRef,
  CursorGetResult,
  DaemonStatus,
  ErrorInfo,
  Event,
  Hello,
  HelloAck,
  ListResult,
  Message,
  Request,
  ServerTarget,
  TaskInfo,
  Stale,
  ValidateResult,
} from '../protocol';
import { daemonLogPath, logDir as logsIn, openLog, pruneLogs, ServerLog } from '../log';
import { FileCursorStore } from '../render/cursor-file';
import { ExitCode } from '../render/exit-codes';
import { sanitizeText } from '../render/sanitize';
import { redactProtocol, redactValue } from '../render/redact';
import { endpointOf, type DaemonPaths } from './paths';
import { ProcessRecord, RECORD_TOUCH_MS } from './records';
import { CREDENTIAL_TTL_MS, ExpiringResolver, SessionManager } from './sessions';
import { envStamp } from './target';
import { encode, LineDecoder, parseMessage } from './wire';

export interface DaemonOptions {
  paths: DaemonPaths;
  /** Compared with the CLI's version in the handshake. */
  version: string;
  /** Exit after this long without connections or requests. */
  idleTimeoutMs: number;
  /** The daemon's own environment: `env:` references resolve against it (see `envStamp`). */
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  now?: () => number;
  /** How often to check that the socket file is still ours; an unreachable daemon exits. */
  watchMs?: number;
  /** Where cursors are stored; default: `cursors/` in the user cache directory (same as in-process mode). */
  cursorDir?: string;
  /** Replaces the default OAuth login store (tests). */
  oauthStore?: OAuthStore;
  /** Where the logs are written; default: `logs/` in the user cache directory. */
  logDir?: string;
  /** Keep a record of this process in `paths.records` (`via daemon run`; see records.ts). */
  record?: boolean;
}

type State = 'new' | 'running' | 'draining' | 'stopped';

interface Connection {
  socket: Socket;
  greeted: boolean;
  /** Requests of this connection that have not been answered yet. */
  inflight: number;
  /** Questions a server asked the person behind a `call` of this connection, waiting for the CLI's `elicit-reply`. */
  elicits: Map<string, { call: string; resolve(answer: ElicitAnswer): void }>;
}

/** Longest a start waits for another starting daemon to finish binding. */
const LOCK_WAIT_MS = 5000;
/** A start lock older than this is a leftover of a crashed daemon. */
const LOCK_STALE_MS = 10_000;
/** Schemas the validate cache keeps. */
const SCHEMA_CACHE = 256;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class DaemonServer {
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private state: State = 'new';
  private server?: Server;
  private readonly connections = new Set<Connection>();
  private inflight = 0;
  private requests = 0;
  private elicitSeq = 0;
  private startedAt = 0;
  private idleTimer?: NodeJS.Timeout;
  private idleDeadline?: number;
  private watchTimer?: NodeJS.Timeout;
  private record?: ProcessRecord;
  private recordTimer?: NodeJS.Timeout;
  private socketIno?: number;
  private token = '';
  /** What the server listens on: the socket path, or for a derived pipe its full name. */
  private endpoint = '';
  private sessions!: SessionManager;
  /** The daemon's own log (`daemon.log`). */
  private log?: ServerLog;
  /** Cursors live in the user cache directory (like in-process mode), so they outlive the daemon. */
  private readonly cursors: FileCursorStore;
  private readonly schemas = new Map<string, JsonSchema>();
  private readonly now: () => number;

  constructor(private readonly options: DaemonOptions) {
    this.now = options.now ?? Date.now;
    const cacheCtx = pathContext({ home: options.home, env: options.env, platform: options.platform });
    this.cursors = new FileCursorStore(options.cursorDir ?? join(userCacheDir(cacheCtx), 'cursors'), { now: this.now });
    this.closed = new Promise((resolve) => (this.resolveClosed = resolve));
    if (options.record) this.record = new ProcessRecord(options.paths.records);
  }

  private logDir(): string {
    return this.options.logDir ?? logsIn(userCacheDir(pathContext({ home: this.options.home, env: this.options.env, platform: this.options.platform })));
  }

  /** A line in `daemon.log` (a crash that `via daemon run` caught, say). */
  note(kind: 'event' | 'error', text: string): void {
    if (kind === 'error') this.log?.error(text);
    else this.log?.event(text);
  }

  get paths(): DaemonPaths {
    return this.options.paths;
  }

  /** What the daemon listens on, once started. */
  get address(): string {
    return this.endpoint;
  }

  /**
   * Bind the socket. Returns `running` when another daemon already answers on it. Starting daemons
   * take a lock around "look for a live one, remove a stale socket, bind", so two of them started
   * by concurrent CLIs cannot remove each other's socket.
   */
  async start(): Promise<'started' | 'running'> {
    const { paths } = this.options;
    // On Windows the directory only holds the token, lock and log; its privacy is the user profile's ACL.
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    // Recorded before the lock: a daemon waiting for it, or binding, is already findable.
    this.record?.write('starting');
    this.recordTimer = setInterval(() => this.record?.touch(), RECORD_TOUCH_MS);
    this.recordTimer.unref();
    try {
      const release = await acquireLock(paths.lock);
      try {
        // A derived pipe is found through the token of the daemon that made it.
        const existing = endpointOf(paths, readFileOrEmpty(paths.token));
        if (existing !== undefined && (await isAlive(existing))) {
          this.forget();
          return 'running';
        }
        if (!paths.pipe && !paths.derived) rmSync(paths.socket, { force: true });
        this.token = randomBytes(32).toString('hex');
        this.endpoint = endpointOf(paths, this.token)!;
        writeFileAtomic(paths.token, this.token);
        await this.listen();
      } finally {
        release();
      }
    } catch (error) {
      this.forget();
      throw error;
    }
    this.record?.write('running');
    this.state = 'running';
    this.startedAt = this.now();
    const ctx = pathContext({ home: this.options.home, env: this.options.env, platform: this.options.platform });
    this.sessions = new SessionManager({
      resolver: new ExpiringResolver(
        () => createCredentialResolver({ home: this.options.home, env: this.options.env, platform: this.options.platform, cwd: this.options.home }),
        CREDENTIAL_TTL_MS,
        this.now,
      ),
      catalogDir: join(userCacheDir(ctx), 'catalog'),
      logDir: this.logDir(),
      env: this.options.env,
      now: this.now,
      home: this.options.home,
      platform: this.options.platform,
      ...(this.options.oauthStore ? { oauthStore: this.options.oauthStore } : {}),
    });
    this.log = new ServerLog(openLog(daemonLogPath(this.logDir())), this.sessions.redact);
    // A pipe's name is derived from the token: it is not written down.
    this.log.event(`started: pid ${process.pid}, version ${this.options.version}${paths.pipe ? '' : `, socket ${this.endpoint}`}`);
    void pruneLogs(this.logDir(), this.now());
    this.updateIdle();
    this.watchTimer = setInterval(() => this.watchSocket(), this.options.watchMs ?? 5000);
    this.watchTimer.unref();
    return 'started';
  }

  /** Finish what is running, then exit. New connections are no longer accepted. */
  drain(): void {
    if (this.state !== 'running') return;
    this.log?.event('draining: no new connections, finishing the requests in flight');
    this.state = 'draining';
    this.record?.write('stopping');
    this.closeListener();
    this.maybeFinishDrain();
  }

  /** Exit now: running requests are abandoned, every session and stdio child is closed. */
  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    const wasNew = this.state === 'new';
    this.state = 'stopped';
    if (!wasNew) this.record?.write('stopping');
    clearTimeout(this.idleTimer);
    clearInterval(this.watchTimer);
    this.closeListener();
    for (const c of this.connections) {
      // `end` lets a reply written a moment ago reach its reader; the timer catches a peer that never closes.
      c.socket.end();
      setTimeout(() => c.socket.destroy(), 1000).unref();
    }
    this.connections.clear();
    if (!wasNew) await this.sessions.closeAll();
    this.log?.event('stopped');
    await this.log?.flush();
    this.removeToken();
    this.forget();
    this.resolveClosed();
  }

  /** Remove this process's record: it is about to exit. */
  private forget(): void {
    clearInterval(this.recordTimer);
    this.record?.remove();
  }

  // Socket ------------------------------------------------------------------------------

  private listen(): Promise<void> {
    const { paths } = this.options;
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.onConnection(socket));
      // The socket must never exist with wider access than 0600, not even for an instant.
      let previous: number | undefined;
      try {
        if (!paths.pipe) previous = process.umask(0o177);
      } catch {
        // worker threads cannot set the umask; the chmod below and the private directory still apply
      }
      const restore = (): void => {
        if (previous !== undefined) process.umask(previous);
      };
      server.once('error', (error) => {
        restore();
        reject(error);
      });
      server.listen(this.endpoint, () => {
        restore();
        server.removeAllListeners('error');
        server.on('error', () => undefined);
        if (!paths.pipe) {
          try {
            chmodSync(this.endpoint, 0o600);
            this.socketIno = statSync(this.endpoint).ino;
          } catch {
            // the watcher notices a missing socket
          }
        }
        this.server = server;
        resolve();
      });
    });
  }

  /** Stop listening and remove the socket file, if it is still the one this daemon made. */
  private closeListener(): void {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    // `close()` unlinks the path it bound by itself, even when somebody else has bound it since;
    // remove it ourselves first, by inode. When the path is no longer ours, leave the handle to
    // process exit instead of closing it.
    if (!this.ownsSocket()) {
      server.unref();
      return;
    }
    if (!this.options.paths.pipe) rmSync(this.endpoint, { force: true });
    server.close();
  }

  private ownsSocket(): boolean {
    if (this.options.paths.pipe) return true;
    try {
      return this.socketIno !== undefined && statSync(this.endpoint).ino === this.socketIno;
    } catch {
      return false;
    }
  }

  private removeToken(): void {
    const { paths } = this.options;
    if (this.token === '') return;
    try {
      if (readFileSync(paths.token, 'utf8') === this.token) rmSync(paths.token, { force: true });
    } catch {
      // already gone
    }
  }

  /**
   * A daemon whose socket file was removed or replaced cannot be reached; leaving it running only leaks.
   * A pipe leaves nothing on disk to watch but the token file: clients find the pipe (derived) or
   * authenticate (fixed) through it, so a daemon whose token file is gone or belongs to another
   * daemon is as unreachable.
   */
  private watchSocket(): void {
    if (this.state !== 'running') return;
    if (this.options.paths.pipe ? readFileOrEmpty(this.options.paths.token) !== this.token : !this.ownsSocket()) {
      this.log?.event('the socket was removed or replaced: exiting');
      void this.stop();
    }
  }

  // Idle exit ---------------------------------------------------------------------------

  private busy(): boolean {
    return this.connections.size > 0 || this.inflight > 0;
  }

  private updateIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleDeadline = undefined;
    if (this.state !== 'running' || this.busy() || this.options.idleTimeoutMs <= 0) return;
    this.idleDeadline = this.now() + this.options.idleTimeoutMs;
    this.idleTimer = setTimeout(() => {
      this.log?.event(`idle for ${Math.round(this.options.idleTimeoutMs / 1000)}s: exiting`);
      void this.stop();
    }, this.options.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private maybeFinishDrain(): void {
    if (this.state === 'draining' && this.inflight === 0) void this.stop();
  }

  // Connections -------------------------------------------------------------------------

  private onConnection(socket: Socket): void {
    if (this.state !== 'running') {
      socket.destroy();
      return;
    }
    const conn: Connection = { socket, greeted: false, inflight: 0, elicits: new Map() };
    this.connections.add(conn);
    this.log?.event(`connection opened (${this.connections.size} open)`);
    this.updateIdle();
    const decoder = new LineDecoder();
    socket.on('data', (chunk) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const line of lines) this.onLine(conn, line);
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.cancelElicits(conn);
      this.connections.delete(conn);
      this.log?.event(`connection closed (${this.connections.size} open)`);
      this.updateIdle();
      this.maybeFinishDrain();
    });
  }

  private send(conn: Connection, message: Message | HelloAck): void {
    if (!conn.socket.destroyed && conn.socket.writable) conn.socket.write(encode(message));
  }

  private onLine(conn: Connection, line: string): void {
    const message = parseMessage(line);
    if (!conn.greeted) {
      this.onHello(conn, message);
      return;
    }
    if (message === undefined || typeof message.id !== 'string' || typeof message.type !== 'string') {
      this.send(conn, { id: typeof message?.id === 'string' ? message.id : '', type: 'result', ok: false, error: { exitCode: ExitCode.Internal, message: 'malformed message' } });
      return;
    }
    void this.serve(conn, message as unknown as Request);
  }

  private onHello(conn: Connection, message: Record<string, unknown> | undefined): void {
    const { version } = this.options;
    const refuse = (reason: NonNullable<HelloAck['reason']>): void => {
      this.send(conn, { type: 'hello', version, ok: false, pid: process.pid, reason });
      conn.socket.end();
    };
    if (message === undefined || message.type !== 'hello') {
      conn.socket.destroy();
      return;
    }
    const hello = message as unknown as Hello;
    if (!tokenMatches(this.token, hello.token)) {
      this.log?.event('handshake refused: wrong token');
      refuse('token');
      return;
    }
    if (hello.version !== version) {
      // A daemon of another version is of no use to this CLI: answer, then stop listening (the
      // socket is gone before the CLI can read the answer, so its successor binds a free path),
      // finish what is running, and exit.
      this.log?.event(`handshake refused: the CLI is version ${String(hello.version).slice(0, 40)}, this daemon ${version}`);
      refuse('version');
      this.drain();
      return;
    }
    conn.greeted = true;
    this.send(conn, { type: 'hello', version, ok: true, pid: process.pid });
  }

  // Requests ----------------------------------------------------------------------------

  private async serve(conn: Connection, request: Request): Promise<void> {
    const started = this.now();
    this.requests += 1;
    this.inflight += 1;
    conn.inflight += 1;
    this.updateIdle();
    try {
      const result = await this.handle(conn, request);
      if (result === STALE) this.send(conn, { id: request.id, type: 'stale', reason: 'environment' } satisfies Stale);
      else this.send(conn, { id: request.id, type: 'result', ok: true, result, meta: { elapsedMs: this.now() - started } });
    } catch (error) {
      const info = this.errorInfo(error);
      this.send(conn, { id: request.id, type: 'result', ok: false, error: info });
      // A failed call is in the log of its server; the other requests are only here.
      if (request.type !== 'call' && request.type !== 'status') this.log?.error(`${request.type} failed (exit ${info.exitCode}): ${info.message.split('\n')[0]!.slice(0, 300)}`);
    } finally {
      this.inflight -= 1;
      conn.inflight -= 1;
      this.updateIdle();
      this.maybeFinishDrain();
    }
  }

  private async handle(conn: Connection, request: Request): Promise<unknown> {
    switch (request.type) {
      case 'status':
        return await this.status();
      case 'list': {
        if (this.stale(request)) return STALE;
        const onWarning = (message: string): void => this.sendWarning(conn, request.id, message);
        const result: ListResult = await this.sessions.list(request, {
          timeoutMs: request.timeoutMs,
          ...(typeof request.waitMs === 'number' ? { waitMs: request.waitMs } : {}),
          refresh: request.refresh === true,
          onWarning,
          ...(typeof request.have === 'number' ? { have: request.have } : {}),
        });
        return result;
      }
      case 'call': {
        if (this.stale(request)) return STALE;
        const onProgress = request.progress
          ? (p: { progress: number; total?: number; message?: string }): void => {
              const data = { progress: p.progress, ...(p.total !== undefined ? { total: p.total } : {}), ...(p.message !== undefined ? { message: this.sessions.redact(p.message) } : {}) };
              this.send(conn, { id: request.id, type: 'event', event: 'progress', data } satisfies Event);
            }
          : undefined;
        const onTask = request.tasks
          ? (task: TaskInfo): void => {
              this.send(conn, { id: request.id, type: 'event', event: 'task', data: redactProtocol(task, this.sessions.redact) } satisfies Event);
            }
          : undefined;
        // The server may ask the person behind this call something; the CLI that made it answers (ADR 0018).
        const elicit: ElicitSink | undefined = request.elicit === true ? { ask: (question) => this.askCli(conn, request.id, question) } : undefined;
        const callOptions = {
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
          ...(typeof request.taskSupport === 'string' ? { taskSupport: request.taskSupport } : {}),
          ...(onProgress ? { onProgress } : {}),
          ...(onTask ? { onTask } : {}),
          ...(elicit ? { elicit } : {}),
          onWarning: (message: string): void => this.sendWarning(conn, request.id, message),
        };
        try {
          if (request.detach === true) return await this.sessions.detach(request, request.rawName, request.args ?? {}, callOptions);
          return await this.sessions.call(request, request.rawName, request.args ?? {}, { ...callOptions, ...(request.retry ? { retry: true } : {}) });
        } finally {
          this.cancelElicits(conn, request.id);
        }
      }
      case 'elicit-reply': {
        const key = String(request.key);
        const waiting = conn.elicits.get(key);
        if (!waiting || waiting.call !== request.call) return { delivered: false };
        conn.elicits.delete(key);
        waiting.resolve(parseAnswer(request.answer));
        return { delivered: true };
      }
      case 'resources-list':
        if (this.stale(request)) return STALE;
        return this.sessions.resources(request, { timeoutMs: request.timeoutMs });
      case 'resource-read':
        if (this.stale(request)) return STALE;
        return this.sessions.readResource(request, String(request.uri), { timeoutMs: request.timeoutMs });
      case 'prompts-list':
        if (this.stale(request)) return STALE;
        return this.sessions.prompts(request, { timeoutMs: request.timeoutMs });
      case 'prompt-get':
        if (this.stale(request)) return STALE;
        return this.sessions.getPrompt(request, String(request.name), promptArgs(request.args), { timeoutMs: request.timeoutMs });
      case 'task': {
        if (this.stale(request)) return STALE;
        // A task in `input_required` asks the person behind this request, like a call does (ADR 0018).
        const elicit: ElicitSink | undefined = request.action === 'wait' && request.elicit === true ? { ask: (question) => this.askCli(conn, request.id, question) } : undefined;
        try {
          return await this.sessions.task(request, request.action, typeof request.taskId === 'string' ? request.taskId : undefined, { timeoutMs: request.timeoutMs, ...(elicit ? { elicit } : {}) });
        } finally {
          if (elicit) this.cancelElicits(conn, request.id);
        }
      }
      case 'skills-list':
        if (this.stale(request)) return STALE;
        return this.sessions.skills(request, { timeoutMs: request.timeoutMs, onWarning: (message: string): void => this.sendWarning(conn, request.id, message) });
      case 'skill-read':
        if (this.stale(request)) return STALE;
        return this.sessions.readSkill(request, String(request.skill), typeof request.file === 'string' ? request.file : undefined, { timeoutMs: request.timeoutMs });
      case 'complete':
        if (this.stale(request)) return STALE;
        return this.sessions.complete(request, completionRef(request.ref), { name: String(request.argument?.name), value: String(request.argument?.value ?? '') }, request.context ? promptArgs(request.context) : undefined, { timeoutMs: request.timeoutMs });
      case 'validate':
        return this.validate(request.schema, request.label, request.data, request.compileOnly === true);
      case 'redact':
        // A value is content the CLI echoes (dry-run arguments); text is something the CLI composed.
        return 'value' in request ? redactValue(request.value, this.sessions.redact) : this.sessions.redact.scan(String(request.text));
      case 'cursor-put':
        return this.cursors.put(request.record);
      case 'cursor-get': {
        const record = await this.cursors.get(String(request.cursor));
        return { record: record ?? null } satisfies CursorGetResult;
      }
      case 'shutdown':
        this.log?.event(`shutdown requested${request.force === true ? ' (force)' : ''}`);
        // Stop listening before answering: the caller may start its successor as soon as it hears back.
        this.drain();
        // `force`: abandon what is in flight and exit now, once this answer is on its way.
        if (request.force === true) setImmediate(() => void this.stop());
        return { pid: process.pid };
      case 'batch':
      case 'auth':
        throw new ClientError({ exitCode: ExitCode.Internal, message: `the daemon does not handle "${request.type}" requests yet`, next: 'via doctor' });
      default:
        throw new ClientError({ exitCode: ExitCode.Internal, message: `unknown message type: ${String((request as { type: unknown }).type).slice(0, 40)}` });
    }
  }

  /** Put a server's question to the CLI that made call `call` and wait for its `elicit-reply`. */
  private askCli(conn: Connection, call: string, question: ElicitQuestion): Promise<ElicitAnswer> {
    if (conn.socket.destroyed || !conn.socket.writable) return Promise.resolve({ action: 'cancel' });
    return new Promise((resolve) => {
      const key = String(++this.elicitSeq);
      conn.elicits.set(key, { call, resolve });
      this.send(conn, { id: call, type: 'event', event: 'elicit', data: { key, question } } satisfies Event);
    });
  }

  /** Nobody is left to answer (the call ended, or the CLI went away): what is still asked counts as cancelled. */
  private cancelElicits(conn: Connection, call?: string): void {
    for (const [key, waiting] of conn.elicits) {
      if (call !== undefined && waiting.call !== call) continue;
      conn.elicits.delete(key);
      waiting.resolve({ action: 'cancel' });
    }
  }

  /** A `log` event for the request that caused it: the CLI prints it as a `warning:` line. */
  private sendWarning(conn: Connection, id: string, message: string): void {
    this.send(conn, { id, type: 'event', event: 'log', data: { level: 'warning', message: this.sessions.redact.scan(message) } } satisfies Event);
  }

  private stale(target: ServerTarget): boolean {
    return target.envStamp !== envStamp(target.server, this.options.env);
  }

  private errorInfo(error: unknown): ErrorInfo {
    if (error instanceof ClientError) return error.info;
    const text = error instanceof Error ? error.message : String(error);
    const line = sanitizeText(this.sessions.redact(text)).split('\n')[0]!.slice(0, 300);
    return { exitCode: ExitCode.Internal, message: `internal error: ${line}`, next: 'via doctor' };
  }

  // Validation --------------------------------------------------------------------------

  /** Schema validation for CLIs that keep ajv out of their process; compiled schemas are cached. */
  private async validate(schema: unknown, label: string, data: unknown, compileOnly: boolean): Promise<ValidateResult> {
    if (typeof schema !== 'object' || schema === null) return { ok: false, reason: 'schema is not an object', warnings: [] };
    const key = createHash('sha1').update(JSON.stringify(schema)).digest('hex');
    let canonical = this.schemas.get(key);
    if (canonical) {
      this.schemas.delete(key); // refresh recency
    } else {
      canonical = schema as JsonSchema;
      if (this.schemas.size >= SCHEMA_CACHE) this.schemas.delete(this.schemas.keys().next().value as string);
    }
    this.schemas.set(key, canonical);
    const result: CompileResult = await compileSchema(canonical, label);
    if (!result.ok) return { ok: false, reason: result.reason, warnings: result.warnings };
    if (compileOnly) return { ok: true, warnings: result.compiled.warnings, errors: [], formats: [] };
    const errors = await result.compiled.check(data);
    const formats = errors.length === 0 ? await result.compiled.formats(data) : [];
    return { ok: true, warnings: result.compiled.warnings, errors, formats };
  }

  // Status ------------------------------------------------------------------------------

  private async status(): Promise<DaemonStatus> {
    const now = this.now();
    // Asking for the status is itself a request on a connection: when nothing else is going on, the
    // daemon would be idle (and start counting) the moment this reply is out.
    const alone = this.inflight === 1 && this.connections.size === 1;
    const idleExit = this.options.idleTimeoutMs <= 0 ? {} : alone ? { idleExitInMs: this.options.idleTimeoutMs } : this.idleDeadline !== undefined ? { idleExitInMs: Math.max(0, this.idleDeadline - now) } : {};
    return {
      pid: process.pid,
      version: this.options.version,
      socket: this.endpoint,
      startedAt: this.startedAt,
      uptimeMs: now - this.startedAt,
      idleTimeoutMs: this.options.idleTimeoutMs,
      ...idleExit,
      requests: this.requests,
      cursors: await this.cursors.count(),
      rssBytes: process.memoryUsage.rss(),
      anonBytes: anonymousBytes(),
      sessions: this.sessions.status(),
    };
  }
}

/**
 * `RssAnon` of this process in bytes: the part of the resident memory that is not file pages (the
 * node executable's mapped pages are shared with every other node process). Linux only; null
 * elsewhere or when `/proc` cannot be read.
 */
function anonymousBytes(): number | null {
  if (process.platform !== 'linux') return null;
  try {
    const match = /^RssAnon:\s+(\d+) kB$/m.exec(readFileSync('/proc/self/status', 'utf8'));
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/** Marker: the request was refused because the caller's environment differs. */
const STALE = Symbol('stale');

// Helpers -------------------------------------------------------------------------------

/** Prompt arguments are strings; anything else a confused caller sent is dropped. */
function promptArgs(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value === 'object' && value !== null) {
    for (const [key, v] of Object.entries(value)) if (typeof v === 'string') Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** A completion reference as the protocol defines it; anything else is refused rather than forwarded. */
function completionRef(value: unknown): CompletionRef {
  const ref = value as { type?: unknown; name?: unknown; uri?: unknown } | null;
  if (ref?.type === 'ref/prompt' && typeof ref.name === 'string') return { type: 'ref/prompt', name: ref.name };
  if (ref?.type === 'ref/resource' && typeof ref.uri === 'string') return { type: 'ref/resource', uri: ref.uri };
  throw new ClientError({ exitCode: ExitCode.Internal, message: 'invalid completion reference' });
}

function tokenMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function readFileOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (error) {
    // Windows refuses to replace a file that a virus scanner or a reader holds open for a moment.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error;
    try {
      writeFileSync(path, content, { mode: 0o600 });
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}

/** Whether something accepts connections on `socket`. A refused or missing socket is stale or absent. */
export function isAlive(socket: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = createConnection(socket);
    const done = (alive: boolean): void => {
      clearTimeout(timer);
      conn.destroy();
      resolve(alive);
    };
    // No answer in time is treated as alive: better to let a busy daemon be than to remove its socket.
    const timer = setTimeout(() => done(true), timeoutMs);
    conn.once('connect', () => done(true));
    conn.once('error', (error: NodeJS.ErrnoException) => done(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT' && error.code !== 'ENOTSOCK'));
  });
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Exclusive create of the lock file; a lock left by a dead process or older than `LOCK_STALE_MS` is taken over. */
async function acquireLock(path: string): Promise<() => void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    try {
      const holder = Number(readFileSync(path, 'utf8'));
      if (!pidAlive(holder) || Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
        rmSync(path, { force: true });
        continue;
      }
    } catch {
      continue; // released between the two calls
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for another daemon to finish starting');
    await sleep(20);
  }
}
