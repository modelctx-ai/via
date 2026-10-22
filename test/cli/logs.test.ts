// `via daemon logs` and the per-server log of an in-process run (daemon.md "日志", cli.md, ADR 0022).
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { daemonLogPath, logDir, serverLogPath } from '../../src/log';
import { CLI_STDIO_SERVER, FAKE_TOKEN, makeSandbox, type Sandbox } from './helpers';

const stdio = (extra = '') =>
  `sources: false\nservers:\n  ask:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(CLI_STDIO_SERVER)}]\n    env: { CLI_FIXTURE_FEATURES: "elicit"${extra} }\n`;

const NOW = 1_800_000_000_000;
const at = (offsetMs: number, tag: string, text: string): string => `${new Date(NOW + offsetMs).toISOString()} ${tag.padEnd(6)} ${text}\n`;

function seed(sb: Sandbox, path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

describe('an in-process run writes the server\'s log', () => {
  it('has the child\'s stderr (redacted), the connection and one line per call, and no arguments', async () => {
    const sb = makeSandbox();
    sb.userConfig(stdio(`, SECRET: "env:GH_TOKEN", CLI_FIXTURE_STDERR_ENV: SECRET`));
    expect((await sb.via(['ask', 'echo-text', '--message', 'argument-value-0123'])).code).toBe(0);
    const log = readFileSync(serverLogPath(logDir(sb.cacheDir), 'ask'), 'utf8');
    expect(log).not.toContain(FAKE_TOKEN);
    expect(log).toMatch(/stderr listening with \*\*\*\n/);
    expect(log).toMatch(/stderr second line without end\n/);
    expect(log).toMatch(/event  starting node(\.exe)?; protocol: newest first/);
    expect(log).toMatch(/event  connected in \d+ms; protocol \S+, \w+/);
    expect(log).toMatch(/event  call echo_text ok in \d+ms\n/);
    expect(log).not.toContain('argument-value-0123');
    expect(log).not.toContain(process.execPath);
    for (const line of log.trimEnd().split('\n')) expect(line).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (stderr|event|error) /);
  });

  it.skipIf(process.platform === 'win32')('keeps the logs private, like the rest of the cache', async () => {
    const sb = makeSandbox();
    sb.userConfig(stdio());
    await sb.via(['ask', 'echo-text', '--message', 'x']);
    const dir = logDir(sb.cacheDir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'servers')).mode & 0o777).toBe(0o700);
    expect(statSync(serverLogPath(dir, 'ask')).mode & 0o777).toBe(0o600);
  });

  it('records a failed start and a failed call', async () => {
    const sb = makeSandbox();
    sb.userConfig(`sources: false\nservers:\n  broken:\n    command: ${JSON.stringify(process.execPath)}\n    args: ["-e", "console.error('boom from the child'); process.exit(3)"]\n    timeout: 5\n`);
    const r = await sb.via(['broken']);
    expect(r.code).toBe(6);
    const log = readFileSync(serverLogPath(logDir(sb.cacheDir), 'broken'), 'utf8');
    expect(log).toContain('stderr boom from the child');
    expect(log).toMatch(/error  connect failed after \d+ms: cannot start broken/);
  });

  it('records what became of a question the server asked, not the question', async () => {
    const sb = makeSandbox();
    sb.userConfig(stdio());
    await sb.via(['ask', 'elicit-form', '--message', 'a very private question'], { answers: ['Zed', 'n', 'n'] });
    const log = readFileSync(serverLogPath(logDir(sb.cacheDir), 'ask'), 'utf8');
    expect(log).toMatch(/user input asked \(form, \d+ field\(s\)\): (decline|accept|cancel)/);
    expect(log).not.toContain('private question');
    expect(log).not.toContain('Zed');
  });
});

describe('via daemon logs', () => {
  it('shows the last lines of a server\'s log, oldest first', async () => {
    const sb = makeSandbox();
    sb.userConfig(stdio());
    const path = serverLogPath(logDir(sb.cacheDir), 'ask');
    seed(sb, path, [at(-3000, 'event', 'one'), at(-2000, 'stderr', '  two'), at(-1000, 'error', 'three')].join(''));
    const all = await sb.via(['daemon', 'logs', 'ask'], { now: NOW });
    expect(all).toMatchObject({ code: 0, stderr: '' });
    expect(all.stdout).toBe(`${at(-3000, 'event', 'one')}${at(-2000, 'stderr', '  two')}${at(-1000, 'error', 'three')}`);
    expect((await sb.via(['daemon', 'logs', 'ask', '-n', '2'], { now: NOW })).stdout).toBe(`${at(-2000, 'stderr', '  two')}${at(-1000, 'error', 'three')}`);
    expect((await sb.via(['daemon', 'logs', 'as', '-n', '1'], { now: NOW })).stdout).toBe(at(-1000, 'error', 'three'));
  });

  it('--since keeps the lines from that long ago', async () => {
    const sb = makeSandbox();
    sb.userConfig(stdio());
    seed(sb, serverLogPath(logDir(sb.cacheDir), 'ask'), [at(-3_600_000, 'event', 'old'), at(-90_000, 'event', 'older'), at(-30_000, 'event', 'recent')].join(''));
    const r = await sb.via(['daemon', 'logs', 'ask', '--since', '1m'], { now: NOW });
    expect(r.stdout).toBe(at(-30_000, 'event', 'recent'));
    const none = await sb.via(['daemon', 'logs', 'ask', '--since', '5s'], { now: NOW });
    expect(none).toMatchObject({ code: 0, stdout: '' });
    expect(none.stderr).toContain('· no log lines in that time · ');
  });

  it('reads rotated copies too', async () => {
    const sb = makeSandbox();
    sb.userConfig(stdio());
    const path = serverLogPath(logDir(sb.cacheDir), 'ask');
    seed(sb, `${path}.1`, at(-2000, 'event', 'before the rotation'));
    seed(sb, path, at(-1000, 'event', 'after'));
    expect((await sb.via(['daemon', 'logs', 'ask'], { now: NOW })).stdout).toBe(`${at(-2000, 'event', 'before the rotation')}${at(-1000, 'event', 'after')}`);
  });

  it('without a provider it is the daemon\'s own log', async () => {
    const sb = makeSandbox();
    sb.userConfig(stdio());
    seed(sb, daemonLogPath(logDir(sb.cacheDir)), at(-1000, 'event', 'started: pid 1'));
    expect((await sb.via(['daemon', 'logs'], { now: NOW })).stdout).toBe(at(-1000, 'event', 'started: pid 1'));
    // it needs no configuration
    const bare = makeSandbox();
    seed(bare, daemonLogPath(logDir(bare.cacheDir)), at(-1000, 'event', 'x'));
    expect((await bare.via(['daemon', 'logs'], { now: NOW })).code).toBe(0);
  });

  it('writes JSON lines with -o json', async () => {
    const sb = makeSandbox();
    sb.userConfig(stdio());
    seed(sb, daemonLogPath(logDir(sb.cacheDir)), at(-1000, 'event', 'started') + at(-500, 'error', 'boom'));
    const r = await sb.via(['daemon', 'logs', '-o', 'json'], { now: NOW });
    expect(r.stdout.trimEnd().split('\n').map((l) => JSON.parse(l))).toEqual([
      { time: new Date(NOW - 1000).toISOString(), source: 'event', text: 'started' },
      { time: new Date(NOW - 500).toISOString(), source: 'error', text: 'boom' },
    ]);
  });

  it('says so when there is no log yet, and exits 0', async () => {
    const sb = makeSandbox();
    sb.userConfig(stdio());
    const r = await sb.via(['daemon', 'logs', 'ask']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(`· no log yet for ask · ${serverLogPath(logDir(sb.cacheDir), 'ask')}\n`);
  });

  it('is a usage error for a bad number or duration and an unknown provider is a not-found', async () => {
    const sb = makeSandbox();
    sb.userConfig(stdio());
    for (const argv of [['-n', 'x'], ['-n', '-1'], ['--since', 'yesterday'], ['--since', '0m'], ['a', 'b'], ['--bogus']]) {
      const r = await sb.via(['daemon', 'logs', ...argv]);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.stderr).toMatch(/^error: /);
    }
    const unknown = await sb.via(['daemon', 'logs', 'nonesuch']);
    expect(unknown.code).toBe(3);
    expect(unknown.stderr).toContain('no such provider: nonesuch');
  });

  it('never prints a control character that found its way into the file', async () => {
    const sb = makeSandbox();
    sb.userConfig(stdio());
    seed(sb, daemonLogPath(logDir(sb.cacheDir)), `${at(-1000, 'event', 'hello \u001b[2J world')}`);
    const r = await sb.via(['daemon', 'logs'], { now: NOW });
    expect(r.stdout).not.toContain('\u001b');
    expect(r.stdout).toContain('hello \\x1b[2J world');
  });

  it('--follow prints what is added, until interrupted', async () => {
    const sb = makeSandbox();
    sb.userConfig(stdio());
    const path = daemonLogPath(logDir(sb.cacheDir));
    seed(sb, path, at(-1000, 'event', 'already there'));
    const stop = new AbortController();
    let stdout = '';
    const { run } = await import('../../src/cli/run');
    const done = run(['daemon', 'logs', '--follow', '-n', '1'], {
      env: { PATH: process.env.PATH, VIA_NO_DAEMON: '1' },
      cwd: sb.project,
      home: sb.home,
      platform: 'linux',
      stdout: { write: (s) => void (stdout += s) },
      stderr: { write: () => undefined },
      now: () => NOW,
      interrupt: stop.signal,
    });
    const { appendFileSync } = await import('node:fs');
    for (let i = 0; i < 100 && !stdout.includes('already there'); i += 1) await new Promise((r) => setTimeout(r, 20));
    appendFileSync(path, at(0, 'event', 'added later'));
    for (let i = 0; i < 100 && !stdout.includes('added later'); i += 1) await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    expect(await done).toBe(0);
    expect(stdout).toBe(`${at(-1000, 'event', 'already there')}${at(0, 'event', 'added later')}`);
  });
});
