// Elicitation through the daemon (daemon.md, "elicitation"; ADR 0018): the daemon has no terminal, so
// a server's question travels to the CLI that made the call as an `elicit` event, and the answer
// comes back as an `elicit-reply` request. First the protocol, with the daemon in this process and a
// connection written by hand; then the real thing, a spawned daemon and the CLI on top.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathContext } from '../../src/config/paths';
import { DaemonConnection } from '../../src/daemon/client';
import { daemonPaths, type DaemonPaths } from '../../src/daemon/paths';
import { DaemonServer } from '../../src/daemon/server';
import { envStamp } from '../../src/daemon/target';
import type { Event, ServerTarget } from '../../src/protocol';
import { CLI_STDIO_SERVER } from '../cli/helpers';
import { stdioServer } from '../helpers/client';
import { daemonSandbox } from '../helpers/daemon';

const VERSION = '9.9.9-test';
const isWindows = process.platform === 'win32';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function start(): Promise<{ connect(): Promise<DaemonConnection> }> {
  const root = mkdtempSync(join(tmpdir(), 'via-el-'));
  const home = join(root, 'home');
  const paths: DaemonPaths = isWindows
    ? daemonPaths(pathContext({ home, env: { LOCALAPPDATA: join(root, 'local'), USERNAME: `via-test-${process.pid}-${Math.random().toString(16).slice(2, 8)}` }, platform: 'win32' }))
    : daemonPaths(pathContext({ home, env: { XDG_RUNTIME_DIR: root }, platform: 'linux' }));
  const env = { PATH: process.env.PATH ?? '', ...(isWindows ? { LOCALAPPDATA: join(root, 'local') } : {}) };
  const daemon = new DaemonServer({ paths, version: VERSION, idleTimeoutMs: 60_000, env, home, platform: isWindows ? 'win32' : 'linux' });
  await daemon.start();
  const conns: DaemonConnection[] = [];
  cleanups.push(async () => {
    for (const c of conns) c.close();
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    connect: async () => {
      const result = await DaemonConnection.connect(paths, VERSION);
      if (!('conn' in result)) throw new Error(`refused: ${result.refused}`);
      conns.push(result.conn);
      return result.conn;
    },
  };
}

const server = () => stdioServer({ args: [CLI_STDIO_SERVER], env: { CLI_FIXTURE_FEATURES: 'elicit' } });
const target = (): ServerTarget => ({ server: server(), cwd: tmpdir(), idleTimeout: 60, envStamp: envStamp(server(), {}) });

describe('the elicit event and elicit-reply', () => {
  it('relays the question to the CLI of the call and the answer to the server', async () => {
    const { connect } = await start();
    const conn = await connect();
    const events: Event[] = [];
    const response = await conn.request(
      { type: 'call', ...target(), rawName: 'elicit_confirm', args: { what: 'ship it' }, elicit: true },
      {
        onEvent: (event) => {
          events.push(event);
          if (event.event !== 'elicit') return;
          const { key } = event.data as { key: string };
          void conn.request({ type: 'elicit-reply', call: event.id, key, answer: { action: 'accept', content: { confirm: true } } }).then((reply) => {
            expect(reply).toMatchObject({ ok: true, result: { delivered: true } });
          });
        },
      },
    );
    expect(response).toMatchObject({ ok: true });
    expect((response as { result: { content: Array<{ text: string }> } }).result.content[0]!.text).toBe('confirmed');
    const asked = events.filter((e) => e.event === 'elicit');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.data).toMatchObject({ question: { mode: 'form', provider: 'mock', message: 'Really ship it?', requestedSchema: { type: 'object' } } });
    expect((asked[0]!.data as { question: { timeLeftMs: number } }).question.timeLeftMs).toBeGreaterThan(0);
  });

  it('a reply nobody is waiting for is not delivered, and neither is one for another call or key', async () => {
    const { connect } = await start();
    const conn = await connect();
    const none = await conn.request({ type: 'elicit-reply', call: '1', key: '1', answer: { action: 'accept' } });
    expect(none).toMatchObject({ ok: true, result: { delivered: false } });
    const seen: Event[] = [];
    const call = conn.request(
      { type: 'call', ...target(), rawName: 'elicit_confirm', args: {}, elicit: true },
      { onEvent: (event) => void seen.push(event) },
    );
    while (!seen.some((e) => e.event === 'elicit')) await new Promise((r) => setTimeout(r, 10));
    const { key } = seen.find((e) => e.event === 'elicit')!.data as { key: string };
    expect(await conn.request({ type: 'elicit-reply', call: 'someone-else', key, answer: { action: 'accept' } })).toMatchObject({ result: { delivered: false } });
    expect(await conn.request({ type: 'elicit-reply', call: seen[0]!.id, key: 'nope', answer: { action: 'accept' } })).toMatchObject({ result: { delivered: false } });
    expect(await conn.request({ type: 'elicit-reply', call: seen[0]!.id, key, answer: { action: 'decline' } })).toMatchObject({ result: { delivered: true } });
    expect(await call).toMatchObject({ ok: true });
    // the same answer cannot be given twice
    expect(await conn.request({ type: 'elicit-reply', call: seen[0]!.id, key, answer: { action: 'accept' } })).toMatchObject({ result: { delivered: false } });
  });

  it('treats a malformed answer as a cancel', async () => {
    const { connect } = await start();
    const conn = await connect();
    const response = await conn.request(
      { type: 'call', ...target(), rawName: 'elicit_form', args: { plain: true }, elicit: true },
      {
        onEvent: (event) => {
          if (event.event === 'elicit') void conn.request({ type: 'elicit-reply', call: event.id, key: (event.data as { key: string }).key, answer: { action: 'accept', content: { name: { nested: true } } } as never });
        },
      },
    );
    expect((response as { result: { content: Array<{ text: string }> } }).result.content[0]!.text).toBe('form answered: cancel {}');
  });

  it('cancels a question whose CLI went away', async () => {
    const { connect } = await start();
    const conn = await connect();
    const other = await connect();
    let sawQuestion!: () => void;
    const asked = new Promise<void>((resolve) => (sawQuestion = resolve));
    void conn.request({ type: 'call', ...target(), rawName: 'elicit_confirm', args: {}, elicit: true }, { onEvent: (e) => e.event === 'elicit' && sawQuestion() }).catch(() => undefined);
    await asked;
    conn.close();
    // the server got a cancel and finished its call: nothing is active on the session any more
    for (;;) {
      const status = await other.request({ type: 'status' });
      if (status.ok && (status.result as { sessions: Array<{ active: number }> }).sessions[0]!.active === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const next = await other.request({ type: 'call', ...target(), rawName: 'elicit_confirm', args: {}, elicit: true }, { onEvent: (e) => e.event === 'elicit' && void other.request({ type: 'elicit-reply', call: e.id, key: (e.data as { key: string }).key, answer: { action: 'decline' } }) });
    expect(next).toMatchObject({ ok: true });
    expect((next as { result: { content: Array<{ text: string }> } }).result.content[0]!.text).toBe('not confirmed (decline)');
  });

  it('a CLI that will decline gets the question too, to say so', async () => {
    const { connect } = await start();
    const conn = await connect();
    const kinds: string[] = [];
    const response = await conn.request(
      { type: 'call', ...target(), rawName: 'elicit_confirm', args: {}, elicit: true },
      {
        onEvent: (event) => {
          kinds.push(event.event);
          if (event.event === 'elicit') void conn.request({ type: 'elicit-reply', call: event.id, key: (event.data as { key: string }).key, answer: { action: 'decline' } });
        },
      },
    );
    expect(kinds).toContain('elicit');
    expect((response as { result: { content: Array<{ text: string }> } }).result.content[0]!.text).toBe('not confirmed (decline)');
  });

  it('declines when the call did not say it can answer (no elicit field)', async () => {
    const { connect } = await start();
    const conn = await connect();
    const events: Event[] = [];
    const response = await conn.request({ type: 'call', ...target(), rawName: 'elicit_confirm', args: {} }, { onEvent: (e) => void events.push(e) });
    expect(events.filter((e) => e.event === 'elicit')).toEqual([]);
    expect((response as { result: { content: Array<{ text: string }> } }).result.content[0]!.text).toBe('not confirmed (decline)');
  });
});

describe('through the CLI and a real daemon', () => {
  const config = `sources: false\nservers:\n  ask:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(CLI_STDIO_SERVER)}]\n    env: { CLI_FIXTURE_FEATURES: "elicit" }\n`;

  it('asks the person at the CLI that made the call and sends the answer to the server', async () => {
    const d = await daemonSandbox(config);
    const r = await d.via(['ask', 'elicit-form', '--plain'], { answers: ['Ann', 'y'] });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('form answered: accept {"name":"Ann"}\n');
    expect(r.asked).toEqual(['1/1 Name (name) - text, 2 to 12 characters, required: ', 'Send these answers to ask? [y]es / [n]o (decline) / [c]ancel: ']);
    expect(r.stderr).toContain('? ask asks for your input (1 field;');
    // the call really went through the daemon, which holds the session
    expect((await d.status())!.sessions[0]).toMatchObject({ server: 'ask', calls: 1 });
  });

  it('without a terminal the daemon path reports exactly what the in-process path does', async () => {
    const d = await daemonSandbox(config);
    const r = await d.via(['ask', 'elicit-confirm']);
    expect(r.code).toBe(5);
    expect(r.stderr).toBe(
      [
        'error: ask asked for user input ("Really proceed?") and no terminal was available to answer',
        'the server then said: not confirmed (decline)',
        'next: ask the user to run this in a terminal: via ask elicit:confirm',
        '',
      ].join('\n'),
    );
  });

  it('a person who cancels is not a refusal: the server decides what the call comes to', async () => {
    const d = await daemonSandbox(config);
    const r = await d.via(['ask', 'elicit-confirm'], { answers: ['yes', 'c'] });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not confirmed (cancel)');
  });
});
