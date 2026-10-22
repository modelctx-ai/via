// The logs of a real daemon (daemon.md "日志", ADR 0022): `daemon.log` for the daemon itself, one file per server
// for its stderr, connection and calls, and `via daemon logs` to read them.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { logDir, serverLogPath } from '../../src/log';
import { CLI_STDIO_SERVER, FAKE_TOKEN } from '../cli/helpers';
import { daemonSandbox, isWindows, waitFor } from '../helpers/daemon';

const config = `sources: false\nservers:\n  ask:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(CLI_STDIO_SERVER)}]\n    env: { CLI_FIXTURE_FEATURES: "elicit", SECRET: "env:GH_TOKEN", CLI_FIXTURE_STDERR_ENV: SECRET }\n`;

describe('daemon logs', () => {
  it('writes the server\'s log (stderr redacted, connection, calls) and its own', async () => {
    const d = await daemonSandbox(config, { GH_TOKEN: FAKE_TOKEN });
    const r = await d.via(['ask', 'echo-text', '--message', 'argument-value-0123']);
    expect(r.code).toBe(0);
    const dir = logDir(d.cacheDir);
    const server = serverLogPath(dir, 'ask');
    await waitFor(() => /call echo_text ok/.test(safeRead(server)), 5000, 'the call to be logged');
    const log = readFileSync(server, 'utf8');
    expect(log).not.toContain(FAKE_TOKEN);
    expect(log).toMatch(/stderr listening with \*\*\*\n/);
    expect(log).toMatch(/event  session opened \(stdio\)/);
    expect(log).toMatch(/event  connected in \d+ms; protocol/);
    expect(log).not.toContain('argument-value-0123');

    const daemonLog = readFileSync(join(dir, 'daemon.log'), 'utf8');
    expect(daemonLog).toMatch(/event  started: pid \d+, version \S+/);
    expect(daemonLog).toMatch(/event  connection opened \(1 open\)/);
    expect(daemonLog).not.toContain(FAKE_TOKEN);
    // the pipe of Windows is named after the token: the name is not written down
    if (isWindows) expect(daemonLog).not.toMatch(/pipe/i);

    const shown = await d.via(['daemon', 'logs', 'ask']);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('call echo_text ok');
    expect((await d.via(['daemon', 'logs'])).stdout).toContain('started: pid');
    expect((await d.via(['daemon', 'logs', 'ask', '-n', '1'])).stdout.trimEnd().split('\n')).toHaveLength(1);
  });

  it.skipIf(isWindows)('keeps them private', async () => {
    const d = await daemonSandbox(config, { GH_TOKEN: FAKE_TOKEN });
    await d.via(['ask', 'echo-text', '--message', 'x']);
    const dir = logDir(d.cacheDir);
    await waitFor(() => readdirSync(dir).includes('daemon.log'), 5000, 'the daemon log');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'daemon.log')).mode & 0o777).toBe(0o600);
    await waitFor(() => readdirSync(join(dir, 'servers')).length > 0, 5000, 'the server log');
    expect(statSync(serverLogPath(dir, 'ask')).mode & 0o777).toBe(0o600);
  });

  it('logs the end of the daemon', async () => {
    const d = await daemonSandbox(config, { GH_TOKEN: FAKE_TOKEN });
    await d.via(['ask', 'echo-text', '--message', 'x']);
    await d.via(['daemon', 'stop']);
    const path = join(logDir(d.cacheDir), 'daemon.log');
    await waitFor(() => /event  stopped\n/.test(safeRead(path)), 5000, 'the stop to be logged');
    const log = readFileSync(path, 'utf8');
    expect(log).toMatch(/event  shutdown requested/);
    expect(log).toMatch(/event  draining/);
  });

  it('logs a failed request of the daemon that is not a call', async () => {
    const d = await daemonSandbox(config, {});
    // a listing of a server whose credential is missing: fails before anything is sent
    const r = await d.via(['ask']);
    expect(r.code).toBe(4);
    const path = join(logDir(d.cacheDir), 'daemon.log');
    await waitFor(() => /error  list failed \(exit 4\)/.test(safeRead(path)), 5000, 'the failure to be logged');
  });
});

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
