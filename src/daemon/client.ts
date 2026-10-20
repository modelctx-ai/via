// The CLI's side of the socket: connect and handshake, start the daemon when there is none, and
// multiplex requests over one connection. Imports nothing heavy (no MCP SDK, no ajv): a request that
// goes through the daemon must not pay for them in the CLI process (implementation.md, "启动速度").
import { closeSync, mkdirSync, openSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import type { Event, Hello, HelloAck, RequestBody, Response, Stale } from '../protocol';
import { unsafeReason, type DaemonPaths } from './paths';
import { encode, LineDecoder, parseMessage } from './wire';

/**
 * The daemon cannot be used: it could not be started, refused the handshake, or the connection broke.
 * `sent` tells whether a request had already been written when that happened, that is, whether it may
 * have run; a caller must not repeat a request that may have had side effects.
 */
export class DaemonUnavailable extends Error {
  constructor(
    message: string,
    readonly sent = false,
  ) {
    super(message);
    this.name = 'DaemonUnavailable';
  }
}

/** The daemon's environment differs from the caller's for a credential variable (see `envStamp`). */
export class DaemonStale extends Error {
  constructor() {
    super('the via daemon was started with a different environment');
    this.name = 'DaemonStale';
  }
}

interface Pending {
  resolve(response: Response): void;
  reject(error: Error): void;
  onEvent?: (event: Event) => void;
  timer?: NodeJS.Timeout;
}

export type ConnectResult = { conn: DaemonConnection } | { refused: 'absent' | 'version' | 'token' | 'draining'; version?: string };

/** One handshaken connection. Requests may overlap; replies are matched by id. */
export class DaemonConnection {
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private lost = false;

  private constructor(
    private readonly socket: Socket,
    private readonly decoder: LineDecoder,
    readonly pid: number,
    readonly version: string,
  ) {
    socket.on('data', (chunk) => this.onData(chunk));
    const gone = (): void => this.fail(new DaemonUnavailable('lost the connection to the via daemon', true));
    socket.on('close', gone);
    socket.on('error', gone);
  }

  get closed(): boolean {
    return this.lost || this.socket.destroyed;
  }

  /** Connect and say hello. Resolves with a refusal instead of throwing for "no daemon" and version/token mismatches. */
  static connect(paths: DaemonPaths, version: string, timeoutMs = 1000): Promise<ConnectResult> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(paths.socket);
      const decoder = new LineDecoder();
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off('data', onData);
        action();
      };
      const refuse = (result: Extract<ConnectResult, { refused: unknown }>): void =>
        finish(() => {
          socket.destroy();
          resolve(result);
        });
      const timer = setTimeout(() => finish(() => {
        socket.destroy();
        reject(new DaemonUnavailable('the via daemon did not answer the handshake'));
      }), timeoutMs);
      const onData = (chunk: Buffer): void => {
        let lines: string[];
        try {
          lines = decoder.push(chunk);
        } catch {
          finish(() => {
            socket.destroy();
            reject(new DaemonUnavailable('the via daemon sent an oversized message'));
          });
          return;
        }
        const message = lines[0] === undefined ? undefined : parseMessage(lines[0]);
        if (message === undefined) return;
        const ack = message as unknown as HelloAck;
        if (ack.type !== 'hello') {
          finish(() => {
            socket.destroy();
            reject(new DaemonUnavailable('the via daemon sent an unexpected handshake'));
          });
        } else if (!ack.ok) {
          refuse({ refused: ack.reason ?? 'version', ...(ack.version ? { version: ack.version } : {}) });
        } else {
          finish(() => resolve({ conn: new DaemonConnection(socket, decoder, ack.pid ?? 0, ack.version) }));
        }
      };
      socket.on('data', onData);
      socket.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'ENOTSOCK') refuse({ refused: 'absent' });
        else finish(() => reject(new DaemonUnavailable(`cannot connect to the via daemon (${error.code ?? error.message})`)));
      });
      socket.once('close', () => refuse({ refused: 'absent' }));
      socket.once('connect', () => {
        const hello: Hello = { type: 'hello', version, pid: process.pid, token: readToken(paths) };
        socket.write(encode(hello));
      });
    });
  }

  /**
   * Send a request and wait for its reply. Rejects with `DaemonStale` when the daemon says its
   * environment differs, and with `DaemonUnavailable` when the connection breaks or `deadlineMs` passes.
   */
  request(body: RequestBody, options: { onEvent?: (event: Event) => void; deadlineMs?: number } = {}): Promise<Response> {
    if (this.closed) return Promise.reject(new DaemonUnavailable('the connection to the via daemon is closed'));
    const id = String(++this.seq);
    return new Promise<Response>((resolve, reject) => {
      const pending: Pending = { resolve, reject, ...(options.onEvent ? { onEvent: options.onEvent } : {}) };
      if (options.deadlineMs !== undefined) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new DaemonUnavailable('the via daemon did not answer in time', true));
          this.socket.destroy();
        }, options.deadlineMs);
      }
      this.pending.set(id, pending);
      this.socket.write(encode({ id, ...body }), (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(new DaemonUnavailable('cannot write to the via daemon', false));
      });
    });
  }

  close(): void {
    this.lost = true;
    this.socket.destroy();
    this.fail(new DaemonUnavailable('the connection to the via daemon was closed'));
  }

  /** Resolves when the daemon closes this connection (it exited, or finished draining). */
  whenClosed(timeoutMs: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private onData(chunk: Buffer): void {
    let lines: string[];
    try {
      lines = this.decoder.push(chunk);
    } catch {
      this.socket.destroy();
      return;
    }
    for (const line of lines) {
      const message = parseMessage(line);
      const id = typeof message?.id === 'string' ? message.id : undefined;
      const pending = id === undefined ? undefined : this.pending.get(id);
      if (!pending || id === undefined) continue;
      if (message?.type === 'event') {
        pending.onEvent?.(message as unknown as Event);
        continue;
      }
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message?.type === 'stale') pending.reject(new DaemonStale());
      else pending.resolve(message as unknown as Response | (Stale & Response));
    }
  }

  private fail(error: Error): void {
    this.lost = true;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
  }
}

function readToken(paths: DaemonPaths): string {
  if (paths.pipe) return '';
  try {
    return readFileSync(paths.token, 'utf8');
  } catch {
    return '';
  }
}

// Starting the daemon ------------------------------------------------------------------

export interface DaemonClientOptions {
  paths: DaemonPaths;
  version: string;
  /** How to run `via`: the executable and the arguments before the subcommand. */
  command: { command: string; args: string[] };
  /** Environment the new daemon gets: `env:` references resolve against it. */
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** `daemon.idleTimeout`, handed to a daemon this client starts. */
  idleTimeoutSec: number;
  /** How long to wait for a started daemon to accept connections (daemon.md: 2 s). */
  readyTimeoutMs?: number;
}

/**
 * V8 and malloc settings for a daemon run by Node on Linux, where it sits for minutes holding a few
 * sessions: a young generation capped at 2 MiB per semi-space (the default lets it grow to 16 MiB
 * after the burst of allocation that loading the MCP SDK and the first requests cause, and V8 keeps
 * the pages), and at most two malloc arenas (glibc otherwise keeps one per thread). Together they take
 * roughly 5-10 MiB off the resident size once a session is up. Scavenges get a little more frequent
 * during a request that allocates a lot; large results go to the large-object space either way.
 * Other runtimes (Bun, a compiled binary) do not get Node's flags.
 */
export function daemonRuntime(command: string): { flags: string[]; env: NodeJS.ProcessEnv } {
  const isNode = command === process.execPath && process.release.name === 'node' && process.versions.bun === undefined;
  if (!isNode) return { flags: [], env: {} };
  return { flags: ['--max-semi-space-size=2'], env: process.platform === 'linux' ? { MALLOC_ARENA_MAX: '2' } : {} };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Keep the log of a failed start short: it is only read back for an error message. */
const LOG_LIMIT = 64 * 1024;

export class DaemonClient {
  private conn?: DaemonConnection;
  private connecting?: Promise<DaemonConnection | undefined>;

  constructor(private readonly options: DaemonClientOptions) {}

  get paths(): DaemonPaths {
    return this.options.paths;
  }

  /**
   * The connection to a running daemon, starting one when `spawn` is set and none answers.
   * Without `spawn`, resolves undefined when there is no daemon. Throws DaemonUnavailable otherwise.
   */
  connection(options: { spawn: boolean }): Promise<DaemonConnection | undefined> {
    if (this.conn && !this.conn.closed) return Promise.resolve(this.conn);
    this.conn = undefined;
    this.connecting ??= this.open(options.spawn).then(
      (conn) => {
        this.connecting = undefined;
        this.conn = conn;
        return conn;
      },
      (error: unknown) => {
        this.connecting = undefined;
        throw error;
      },
    );
    return this.connecting;
  }

  /** Ask the daemon to finish and exit, and forget the connection. Resolves once its socket is gone. */
  async restart(): Promise<void> {
    const conn = this.conn;
    this.conn = undefined;
    if (!conn || conn.closed) return;
    await conn.request({ type: 'shutdown' }, { deadlineMs: 2000 }).catch(() => undefined);
    conn.close();
  }

  close(): void {
    this.conn?.close();
    this.conn = undefined;
  }

  private async open(spawnIfAbsent: boolean): Promise<DaemonConnection | undefined> {
    const { paths, version } = this.options;
    const unsafe = unsafeReason(paths);
    if (unsafe) throw new DaemonUnavailable(`not using the via daemon: ${unsafe}`);
    const first = await DaemonConnection.connect(paths, version);
    if ('conn' in first) return first.conn;
    if (first.refused === 'token') throw new DaemonUnavailable('the via daemon refused the handshake (token mismatch)');
    if (!spawnIfAbsent) return undefined;
    // No daemon, or one of another version that is draining and has already released the socket.
    const child = await this.spawnDaemon();
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 2000);
    let attempt = 0;
    for (;;) {
      const failure = child.failure();
      if (failure !== undefined) throw new DaemonUnavailable(`cannot start the via daemon: ${failure}`);
      const result = await DaemonConnection.connect(paths, version);
      if ('conn' in result) return result.conn;
      if (result.refused === 'token') throw new DaemonUnavailable('the via daemon refused the handshake (token mismatch)');
      if (Date.now() > deadline) throw new DaemonUnavailable(`the via daemon did not start within ${(this.options.readyTimeoutMs ?? 2000) / 1000}s${child.tail()}`);
      attempt += 1;
      await sleep(Math.min(10 + attempt * 5, 40));
    }
  }

  private async spawnDaemon(): Promise<{ failure(): string | undefined; tail(): string }> {
    // Loaded here: only a command that has to start the daemon needs child_process (and its ~3 ms).
    const { spawn } = await import('node:child_process');
    const { paths, command, env, home, idleTimeoutSec } = this.options;
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    let logFd: number | undefined;
    try {
      if (statSizeOf(paths.log) > LOG_LIMIT) truncateSync(paths.log, 0);
      logFd = openSync(paths.log, 'a', 0o600);
    } catch {
      logFd = undefined;
    }
    const childEnv: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(env)) if (value !== undefined) childEnv[name] = value;
    childEnv.HOME ??= home;
    const runtime = daemonRuntime(command.command);
    for (const [name, value] of Object.entries(runtime.env)) childEnv[name] ??= value;
    const args = [...runtime.flags, ...command.args, 'daemon', 'run', '--socket', paths.socket, '--idle-timeout', String(idleTimeoutSec)];
    let failure: string | undefined;
    const child = spawn(command.command, args, {
      detached: true,
      stdio: ['ignore', 'ignore', logFd ?? 'ignore'],
      env: childEnv,
      cwd: home,
      windowsHide: true,
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      failure = `${error.code ?? 'spawn failed'}`;
    });
    // A daemon that exits at once with an error (bad socket path, no permission) will not become ready.
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) failure = `it exited with code ${code}${logTail(paths.log)}`;
    });
    child.unref();
    if (logFd !== undefined) closeSync(logFd);
    return { failure: () => failure, tail: () => logTail(paths.log) };
  }
}

function statSizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Last line the daemon wrote to its log, for an error message. */
function logTail(path: string): string {
  try {
    const last = readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).pop();
    return last ? ` (${last.slice(0, 200)})` : '';
  } catch {
    return '';
  }
}
