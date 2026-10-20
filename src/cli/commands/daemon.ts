// `via daemon status|stop|run` (cli.md, daemon.md). `status` and `stop` only talk to a daemon that
// is already there; `run` is the daemon itself, in the foreground, which is how the CLI starts it
// (detached) on first use.
import { ExitCode } from '../../render/exit-codes';
import { alignRows } from '../../render/width';
import type { DaemonStatus } from '../../protocol';
import type { App } from '../app';
import { daemonDisabled } from '../app';
import { usageFailure } from '../failure';
import { parseLocal } from '../options';

const USAGE = 'usage: via daemon status|stop|run [--socket <path>] [--idle-timeout <seconds>]';

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

async function status(app: App): Promise<number> {
  const json = app.options.format === 'json';
  if (daemonDisabled(app.io)) {
    app.out(json ? `${JSON.stringify({ running: false, disabled: true })}\n` : 'daemon: disabled (VIA_NO_DAEMON)\n');
    return ExitCode.Ok;
  }
  const client = await app.daemonClient();
  const conn = await client.connection({ spawn: false });
  if (!conn) {
    app.out(json ? `${JSON.stringify({ running: false, socket: client.paths.socket })}\n` : `daemon: not running\nsocket: ${client.paths.socket}\n`);
    return ExitCode.Ok;
  }
  const response = await conn.request({ type: 'status' }, { deadlineMs: 5000 });
  if (!response.ok) throw usageFailure(response.error.message, 'via doctor');
  const result = response.result as DaemonStatus;
  app.out(json ? `${JSON.stringify({ running: true, ...result }, null, 2)}\n` : renderStatus(result));
  return ExitCode.Ok;
}

// stop --------------------------------------------------------------------------------------

async function stop(app: App): Promise<number> {
  const json = app.options.format === 'json';
  const say = (stopped: boolean, text: string, extra: Record<string, unknown> = {}): void =>
    app.out(json ? `${JSON.stringify({ running: !stopped, ...extra })}\n` : `${text}\n`);
  if (daemonDisabled(app.io)) {
    say(true, 'daemon: disabled (VIA_NO_DAEMON)', { disabled: true });
    return ExitCode.Ok;
  }
  const conn = await (await app.daemonClient()).connection({ spawn: false });
  if (!conn) {
    say(true, 'daemon: not running');
    return ExitCode.Ok;
  }
  const response = await conn.request({ type: 'shutdown' }, { deadlineMs: 5000 });
  if (!response.ok) throw usageFailure(response.error.message, 'via doctor');
  // The daemon closes this connection when it has finished what was running.
  const closed = await conn.whenClosed(5000);
  say(closed, closed ? `daemon: stopped (pid ${conn.pid})` : `daemon: stopping, waiting for requests in flight (pid ${conn.pid})`, { pid: conn.pid });
  return ExitCode.Ok;
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
  const [{ DaemonServer }, { daemonPaths }, { VERSION }, { pathContext }] = await Promise.all([
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
  });
  if ((await daemon.start()) === 'running') {
    app.err(`daemon: already running on ${paths.socket}\n`);
    return ExitCode.Ok;
  }
  // Started by hand: say where it listens. Started by the CLI its stderr goes to a log file.
  if (process.stderr.isTTY) app.err(`daemon: listening on ${paths.socket} (exits after ${formatDuration(idleTimeoutSec * 1000)} idle)\n`);
  const onSignal = (): void => void daemon.stop();
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, onSignal);
  const onCrash = (error: unknown): void => {
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
