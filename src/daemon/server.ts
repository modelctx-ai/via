// The daemon (daemon.md): a unix-socket server that keeps MCP sessions, tool lists, resolved
// credentials and truncation cursors for every `via` process of one user. The CLI parses arguments
// and renders; the daemon answers with structured results.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import type { JsonSchema } from '../catalog/types';
import { compileSchema, type CompileResult } from '../cli/args/validate';
import { ClientError } from '../client';
import { createCredentialResolver } from '../config/credentials';
import { pathContext, userCacheDir } from '../config/paths';
import type {
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
  Stale,
  ValidateResult,
} from '../protocol';
import { MemoryCursorStore, type CursorRecord } from '../render/cursor';
import { ExitCode } from '../render/exit-codes';
import { sanitizeText } from '../render/pipeline';
import type { DaemonPaths } from './paths';
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
}

type State = 'new' | 'running' | 'draining' | 'stopped';

interface Connection {
  socket: Socket;
  greeted: boolean;
  /** Requests of this connection that have not been answered yet. */
  inflight: number;
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
  private startedAt = 0;
  private idleTimer?: NodeJS.Timeout;
  private idleDeadline?: number;
  private watchTimer?: NodeJS.Timeout;
  private socketIno?: number;
  private token = '';
  private sessions!: SessionManager;
  private readonly cursors: MemoryCursorStore;
  private readonly schemas = new Map<string, JsonSchema>();
  private readonly now: () => number;

  constructor(private readonly options: DaemonOptions) {
    this.now = options.now ?? Date.now;
    this.cursors = new MemoryCursorStore({ now: this.now });
    this.closed = new Promise((resolve) => (this.resolveClosed = resolve));
  }

  get paths(): DaemonPaths {
    return this.options.paths;
  }

  /**
   * Bind the socket. Returns `running` when another daemon already answers on it. Starting daemons
   * take a lock around "look for a live one, remove a stale socket, bind", so two of them started
   * by concurrent CLIs cannot remove each other's socket.
   */
  async start(): Promise<'started' | 'running'> {
    const { paths } = this.options;
    if (!paths.pipe) mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const release = paths.pipe ? () => undefined : await acquireLock(paths.lock);
    try {
      if (await isAlive(paths.socket)) return 'running';
      if (!paths.pipe) rmSync(paths.socket, { force: true });
      this.token = randomBytes(32).toString('hex');
      if (!paths.pipe) writeFileAtomic(paths.token, this.token);
      await this.listen();
    } finally {
      release();
    }
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
      env: this.options.env,
      now: this.now,
    });
    this.updateIdle();
    this.watchTimer = setInterval(() => this.watchSocket(), this.options.watchMs ?? 5000);
    this.watchTimer.unref();
    return 'started';
  }

  /** Finish what is running, then exit. New connections are no longer accepted. */
  drain(): void {
    if (this.state !== 'running') return;
    this.state = 'draining';
    this.closeListener();
    this.maybeFinishDrain();
  }

  /** Exit now: running requests are abandoned, every session and stdio child is closed. */
  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    const wasNew = this.state === 'new';
    this.state = 'stopped';
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
    this.removeToken();
    this.resolveClosed();
  }

  // Socket ------------------------------------------------------------------------------

  private listen(): Promise<void> {
    const { paths } = this.options;
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.onConnection(socket));
      // The socket must never exist with wider access than 0600, not even for an instant.
      let previous: number | undefined;
      try {
        previous = process.umask(0o177);
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
      server.listen(paths.socket, () => {
        restore();
        server.removeAllListeners('error');
        server.on('error', () => undefined);
        if (!paths.pipe) {
          try {
            chmodSync(paths.socket, 0o600);
            this.socketIno = statSync(paths.socket).ino;
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
    if (!this.options.paths.pipe) rmSync(this.options.paths.socket, { force: true });
    server.close();
  }

  private ownsSocket(): boolean {
    if (this.options.paths.pipe) return true;
    try {
      return this.socketIno !== undefined && statSync(this.options.paths.socket).ino === this.socketIno;
    } catch {
      return false;
    }
  }

  private removeToken(): void {
    const { paths } = this.options;
    if (paths.pipe || this.token === '') return;
    try {
      if (readFileSync(paths.token, 'utf8') === this.token) rmSync(paths.token, { force: true });
    } catch {
      // already gone
    }
  }

  /** A daemon whose socket file was removed or replaced cannot be reached; leaving it running only leaks. */
  private watchSocket(): void {
    if (this.state !== 'running') return;
    if (!this.options.paths.pipe && !this.ownsSocket()) void this.stop();
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
    this.idleTimer = setTimeout(() => void this.stop(), this.options.idleTimeoutMs);
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
    const conn: Connection = { socket, greeted: false, inflight: 0 };
    this.connections.add(conn);
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
      this.connections.delete(conn);
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
    if (!this.options.paths.pipe && !tokenMatches(this.token, hello.token)) {
      refuse('token');
      return;
    }
    if (hello.version !== version) {
      // A daemon of another version is of no use to this CLI: answer, then stop listening (the
      // socket is gone before the CLI can read the answer, so its successor binds a free path),
      // finish what is running, and exit.
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
      this.send(conn, { id: request.id, type: 'result', ok: false, error: this.errorInfo(error) });
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
        return this.status();
      case 'list': {
        if (this.stale(request)) return STALE;
        const result: ListResult = await this.sessions.list(request, { timeoutMs: request.timeoutMs, refresh: request.refresh === true });
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
        return this.sessions.call(request, request.rawName, request.args ?? {}, {
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
          ...(request.retry ? { retry: true } : {}),
          ...(onProgress ? { onProgress } : {}),
        });
      }
      case 'validate':
        return this.validate(request.schema, request.label, request.data, request.compileOnly === true);
      case 'redact':
        return this.sessions.redact(String(request.text));
      case 'cursor-put':
        return this.cursors.put(request.record);
      case 'cursor-get': {
        const record = await this.cursors.get(String(request.cursor));
        return { record: record ?? null } satisfies CursorGetResult;
      }
      case 'shutdown':
        // Stop listening before answering: the caller may start its successor as soon as it hears back.
        this.drain();
        return { pid: process.pid };
      case 'batch':
      case 'auth':
        throw new ClientError({ exitCode: ExitCode.Internal, message: `the daemon does not handle "${request.type}" requests yet`, next: 'via doctor' });
      default:
        throw new ClientError({ exitCode: ExitCode.Internal, message: `unknown message type: ${String((request as { type: unknown }).type).slice(0, 40)}` });
    }
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

  private status(): DaemonStatus {
    const now = this.now();
    return {
      pid: process.pid,
      version: this.options.version,
      socket: this.options.paths.socket,
      startedAt: this.startedAt,
      uptimeMs: now - this.startedAt,
      idleTimeoutMs: this.options.idleTimeoutMs,
      ...(this.idleDeadline !== undefined ? { idleExitInMs: Math.max(0, this.idleDeadline - now) } : {}),
      requests: this.requests,
      cursors: this.cursors.size,
      rssBytes: process.memoryUsage.rss(),
      sessions: this.sessions.status(),
    };
  }
}

/** Marker: the request was refused because the caller's environment differs. */
const STALE = Symbol('stale');

// Helpers -------------------------------------------------------------------------------

function tokenMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
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
