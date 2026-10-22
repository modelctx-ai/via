// `via daemon status|stop|run` (cli.md, daemon.md). `status` and `stop` only talk to a daemon that
// is already there; `run` is the daemon itself, in the foreground, which is how the CLI starts it
// (detached) on first use.
import { ExitCode } from '../../render/exit-codes';
import { alignRows } from '../../render/width';
import type { DaemonStatus } from '../../protocol';
import type { DaemonClient, DaemonConnection } from '../../daemon/client';
import type { DaemonProcess } from '../../daemon/records';
import type { App } from '../app';
import { fail, usageFailure } from '../failure';
import { parseLocal } from '../options';

const USAGE = 'usage: via daemon status|stop|run [--socket <path>] [--idle-timeout <seconds>] | via daemon logs [<provider>] [-n <lines>] [--follow] [--since <duration>]';

export async function daemonCommand(app: App, argv: readonly string[]): Promise<number> {
  const [action, ...rest] = argv;
  switch (action) {
    case 'status':
      noArguments(rest, 'status');
      return status(app);
    case 'stop':
      noArguments(rest, 'stop');
      return stop(app);
    case 'run':
      return runDaemon(app, rest);
    case 'logs':
      return logs(app, rest);
    default:
      throw usageFailure(action === undefined ? USAGE : `unknown daemon action: ${action.slice(0, 40)}`, 'via daemon -h');
  }
}

function noArguments(rest: readonly string[], action: string): void {
  if (rest.length > 0) throw usageFailure(`via daemon ${action} takes no arguments`, 'via daemon -h');
}

// status ------------------------------------------------------------------------------------

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The text form of `DaemonStatus`: names and counters only. */
export function renderStatus(s: DaemonStatus): string {
  const head = [`daemon: running`, `pid ${s.pid}`, `v${s.version}`, `up ${formatDuration(s.uptimeMs)}`, formatMegabytes(s.rssBytes)];
  head.push(s.idleExitInMs === undefined ? 'busy' : `exits when idle in ${formatDuration(s.idleExitInMs)}`);
  const lines = [head.join(' · '), `socket: ${s.socket}`];
  if (s.sessions.length === 0) lines.push('sessions: none');
  else {
    lines.push(`sessions: ${s.sessions.length}`);
    const rows = s.sessions.map((e) => [
      `  ${e.provider}`,
      e.transport,
      e.connected ? (e.pid !== undefined ? `running (pid ${e.pid})` : 'connected') : 'stopped',
      e.tools !== undefined ? `${e.tools} tools` : '-',
      `${e.calls} ${e.calls === 1 ? 'call' : 'calls'}`,
      e.active > 0 ? `${e.active} active` : `idle ${formatDuration(e.lastUsedAgoMs)}`,
    ]);
    lines.push(...alignRows(rows));
  }
  if (s.cursors > 0) lines.push(`cursors: ${s.cursors}`);
  return `${lines.join('\n')}\n`;
}

/** A daemon process that does not answer on the socket (records.ts), as one line. */
export function renderProcess(p: DaemonProcess): string {
  if (p.state === 'starting') return `daemon: starting · pid ${p.pid}`;
  if (p.state === 'stopping') return `daemon: stopping · pid ${p.pid} · finishing requests in flight`;
  return `daemon: not reachable · pid ${p.pid}`;
}

/**
 * The daemon that answers on the socket, if any, and the daemon processes recorded beside it. A
 * daemon that cannot be reached (it does not finish the handshake; on Windows a stopping daemon's
 * pipe lingers while a connection to it is open) is left to the records; with none to show, the
 * reason it could not be reached is the answer.
 */
async function find(app: App): Promise<{ client: DaemonClient; conn?: DaemonConnection; processes: DaemonProcess[] }> {
  const client = await app.daemonClient();
  let conn: DaemonConnection | undefined;
  let unreachable: unknown;
  try {
    conn = await client.connection({ spawn: false });
  } catch (error) {
    if (!(error instanceof Error && error.name === 'DaemonUnavailable')) throw error;
    unreachable = error;
  }
  const { daemonProcesses } = await import('../../daemon/records');
  const processes = daemonProcesses(client.paths.records);
  if (unreachable !== undefined && processes.length === 0) throw unreachable;
  return { client, ...(conn ? { conn } : {}), processes };
}

async function status(app: App): Promise<number> {
  const json = app.options.format === 'json';
  if (app.daemonOff) {
    app.out(json ? `${JSON.stringify({ running: false, disabled: true })}\n` : 'daemon: disabled (VIA_NO_DAEMON)\n');
    return ExitCode.Ok;
  }
  const { client, conn, processes } = await find(app);
  if (!conn) {
    const { describeEndpoint } = await import('../../daemon/paths');
    const socket = describeEndpoint(client.paths);
    // Not listening is not the same as not running: one may be starting, or finishing requests after `stop`.
    if (json) app.out(`${JSON.stringify({ running: false, socket, ...(processes.length > 0 ? { processes } : {}) })}\n`);
    else app.out(`${processes.length > 0 ? processes.map(renderProcess).join('\n') : 'daemon: not running'}\nsocket: ${socket}\n`);
    return ExitCode.Ok;
  }
  const response = await conn.request({ type: 'status' }, { deadlineMs: 5000 });
  if (!response.ok) throw usageFailure(response.error.message, 'via doctor');
  const result = response.result as DaemonStatus;
  // An older daemon may still be finishing its requests next to this one.
  const others = processes.filter((p) => p.pid !== result.pid);
  if (json) app.out(`${JSON.stringify({ running: true, ...result, ...(others.length > 0 ? { processes: others } : {}) }, null, 2)}\n`);
  else app.out(renderStatus(result) + others.map((p) => `also: ${renderProcess(p).slice('daemon: '.length)}\n`).join(''));
  return ExitCode.Ok;
}

// stop --------------------------------------------------------------------------------------

/** How long `stop` lets a daemon finish its requests in flight before it has them abandoned. */
const STOP_GRACE_MS = 5000;
/** How long a daemon told to exit now (or signalled) gets to close its servers and go. */
const STOP_FORCE_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `pid` has exited; false when it is still there after `ms`. */
async function exited(pid: number, ms: number, running: (pid: number) => boolean): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (running(pid)) {
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
  return true;
}

/**
 * Stop the daemon that answers on the socket, and every other daemon process of this socket that
 * does not (records.ts): one still starting, or one that removed its socket and is finishing requests.
 * Requests in flight get `STOP_GRACE_MS`; after that they are abandoned and the daemon exits.
 */
async function stop(app: App): Promise<number> {
  const json = app.options.format === 'json';
  if (app.daemonOff) {
    app.out(json ? `${JSON.stringify({ running: false, disabled: true })}\n` : 'daemon: disabled (VIA_NO_DAEMON)\n');
    return ExitCode.Ok;
  }
  const { client, conn } = await find(app);
  const { daemonProcesses, running } = await import('../../daemon/records');
  // The daemon of a test may run in this very process (and an old one may not say its pid): wait for
  // its connection to close instead, and never signal it.
  const own = (pid: number): boolean => pid === process.pid || pid <= 0;
  const gone = (pid: number, ms: number, closed: () => Promise<boolean>): Promise<boolean> => (own(pid) ? closed() : exited(pid, ms, running));
  const stopped: number[] = [];
  const failed: number[] = [];
  let abandoned = false;
  if (conn) {
    // A daemon that does not even answer `shutdown` is signalled like one without a socket.
    const response = await conn.request({ type: 'shutdown' }, { deadlineMs: 5000 }).catch((error: unknown) => {
      if (!(error instanceof Error && error.name === 'DaemonUnavailable')) throw error;
      return undefined;
    });
    if (response && !response.ok) throw usageFailure(response.error.message, 'via doctor');
    let done = response ? await gone(conn.pid, STOP_GRACE_MS, () => conn.whenClosed(STOP_GRACE_MS)) : false;
    if (!done) {
      abandoned = true;
      if (!conn.closed) await conn.request({ type: 'shutdown', force: true }, { deadlineMs: 2000 }).catch(() => undefined);
      else if (!own(conn.pid)) signal(conn.pid);
      done = await gone(conn.pid, STOP_FORCE_MS, () => conn.whenClosed(STOP_FORCE_MS));
    }
    (done ? stopped : failed).push(conn.pid);
    conn.close();
  }
  // No socket to ask them on: SIGTERM, on which a daemon closes its servers and exits at once.
  const others = daemonProcesses(client.paths.records).filter((p) => p.pid !== conn?.pid);
  for (const p of others) signal(p.pid);
  for (const p of others) {
    (await exited(p.pid, STOP_FORCE_MS, running) ? stopped : failed).push(p.pid);
    if (p.state === 'stopping') abandoned = true;
  }
  if (failed.length > 0) {
    throw fail(ExitCode.Internal, `the via daemon did not exit (pid ${failed.join(', ')})`, `kill ${failed.join(' ')}`);
  }
  if (json) app.out(`${JSON.stringify({ running: false, ...(conn ? { pid: conn.pid } : {}), stopped, ...(abandoned ? { abandoned: true } : {}) })}\n`);
  else if (stopped.length === 0) app.out('daemon: not running\n');
  else app.out(`daemon: stopped (pid ${stopped.join(', ')})${abandoned ? ', requests in flight abandoned' : ''}\n`);
  return ExitCode.Ok;
}

function signal(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // gone already
  }
}

// run ---------------------------------------------------------------------------------------

async function runDaemon(app: App, argv: readonly string[]): Promise<number> {
  const { flags, positionals } = parseLocal('daemon run', argv, [
    { name: 'socket', value: true },
    { name: 'idle-timeout', value: true },
  ]);
  if (positionals.length > 0) throw usageFailure('via daemon run takes no arguments', 'via daemon -h');
  let idleTimeoutSec: number;
  if (typeof flags['idle-timeout'] === 'string') {
    idleTimeoutSec = Number(flags['idle-timeout']);
    if (!Number.isFinite(idleTimeoutSec) || idleTimeoutSec < 0) throw usageFailure('--idle-timeout must be a number of seconds', 'via daemon -h');
  } else {
    idleTimeoutSec = (await app.config({ allowErrors: true })).daemon.idleTimeout;
  }
  const [{ DaemonServer }, { daemonPaths, describeEndpoint }, { VERSION }, { pathContext }] = await Promise.all([
    import('../../daemon/server'),
    import('../../daemon/paths'),
    import('../help'),
    import('../../config/paths'),
  ]);
  const ctx = pathContext({ home: app.io.home, env: app.io.env, platform: app.io.platform });
  const paths = daemonPaths(ctx, typeof flags.socket === 'string' ? flags.socket : undefined);
  const daemon = new DaemonServer({
    paths,
    version: VERSION,
    idleTimeoutMs: idleTimeoutSec * 1000,
    env: app.io.env as NodeJS.ProcessEnv,
    home: app.io.home,
    platform: app.io.platform,
    record: true,
  });
  if ((await daemon.start()) === 'running') {
    app.err(`daemon: already running on ${describeEndpoint(paths)}\n`);
    return ExitCode.Ok;
  }
  // Started by hand: say where it listens. Started by the CLI its stderr goes to a log file.
  if (process.stderr.isTTY) app.err(`daemon: listening on ${daemon.address} (exits after ${formatDuration(idleTimeoutSec * 1000)} idle)\n`);
  const onSignal = (): void => void daemon.stop();
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, onSignal);
  const onCrash = (error: unknown): void => {
    daemon.note('error', `crash: ${error instanceof Error ? error.message.split('\n')[0] : String(error).split('\n')[0]}`);
    process.stderr.write(`daemon: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    void daemon.stop();
  };
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  await daemon.closed;
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.off(signal, onSignal);
  process.off('uncaughtException', onCrash);
  process.off('unhandledRejection', onCrash);
  return ExitCode.Ok;
}

// logs --------------------------------------------------------------------------------------

/** Lines shown when `-n` is not given. */
const DEFAULT_LOG_LINES = 50;

/**
 * `via daemon logs [<provider>] [-n N] [--follow] [--since <duration>]` (daemon.md, "日志"): the daemon's own
 * log, or the log of one server (its stdio stderr, connection and protocol events, one line per call). Reads
 * files; works with the daemon stopped and in `VIA_NO_DAEMON` mode, where only the server logs are written.
 */
async function logs(app: App, argv: readonly string[]): Promise<number> {
  const { flags, positionals } = parseLocal('daemon logs', argv, [
    { name: 'n', short: 'n', value: true },
    { name: 'follow', short: 'f', value: false },
    { name: 'since', value: true },
  ]);
  if (positionals.length > 1) throw usageFailure('usage: via daemon logs [<provider>] [-n <lines>] [--follow] [--since <duration>]', 'via daemon -h');
  let count = DEFAULT_LOG_LINES;
  if (typeof flags.n === 'string') {
    count = /^\d+$/.test(flags.n) ? Number(flags.n) : Number.NaN;
    if (!Number.isSafeInteger(count)) throw usageFailure(`-n must be a number of lines (got ${JSON.stringify(flags.n.slice(0, 40))})`, 'via daemon -h');
  }
  const { parseDuration, readLog, followLog } = await import('../../log/read');
  let since: number | undefined;
  if (typeof flags.since === 'string') {
    const span = parseDuration(flags.since);
    if (span === undefined) throw usageFailure(`--since must be a duration such as 30s, 10m, 2h or 1d (got ${JSON.stringify(flags.since.slice(0, 40))})`, 'via daemon -h');
    since = app.io.now() - span;
  }
  const { daemonLogPath, logDir, serverLogPath } = await import('../../log');
  const dir = logDir(app.cacheDir);
  const name = positionals[0] === undefined ? undefined : (await (await import('../target')).resolveEntry(app, positionals[0])).server.name;
  const path = name === undefined ? daemonLogPath(dir) : serverLogPath(dir, name);
  const json = app.options.format === 'json';
  const show = (lines: Array<{ time: number | undefined; source: string; text: string; raw: string }>): void => {
    if (lines.length === 0) return;
    app.out(
      lines
        .map((l) => (json ? JSON.stringify({ time: l.time === undefined ? null : new Date(l.time).toISOString(), source: l.source, text: l.text }) : l.raw))
        .join('\n') + '\n',
    );
  };
  const existing = await readLog(path, { count, ...(since !== undefined ? { since } : {}) });
  show(existing);
  if (existing.length === 0 && flags.follow !== true) {
    const { stat } = await import('node:fs/promises');
    const exists = await stat(path).then(() => true, () => false);
    app.err(`· ${exists ? `no log lines${since !== undefined ? ' in that time' : ''}` : `no log yet for ${name ?? 'the daemon'}`} · ${path}\n`);
  }
  if (flags.follow !== true) return ExitCode.Ok;
  // Until the person interrupts (tests hand in a signal of their own).
  const stopper = new AbortController();
  const onSignal = (): void => stopper.abort();
  const signal = app.io.interrupt ?? stopper.signal;
  if (!app.io.interrupt) for (const s of ['SIGINT', 'SIGTERM'] as const) process.once(s, onSignal);
  try {
    await followLog(path, { signal, onLines: show });
  } finally {
    if (!app.io.interrupt) for (const s of ['SIGINT', 'SIGTERM'] as const) process.off(s, onSignal);
  }
  return ExitCode.Ok;
}
