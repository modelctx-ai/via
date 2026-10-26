import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run } from '../../src/cli/run';
import { rejectAuthCommand } from '../../bench/eval/auth-guard';
import { gateOf, median, summarize, summarizeCondition, wilson } from '../../bench/eval/aggregate';
import { authUnusable, needsInteractiveLogin, preflightAuth } from '../../bench/eval/preflight-auth';
import { fakeModelFactory } from '../../bench/eval/fake';
import { judge, matchSpec, successOf, type LoggedCall } from '../../bench/eval/judge';
import { loadSuite, type LoadedSuite } from '../../bench/harness/load';
import { main, parseArgs } from '../../bench/eval/main';
import { buildSystemPrompt } from '../../bench/eval/prompts';
import { FAKE_BANNER, formatConsole, formatJson, formatMarkdown, type EvalMeta } from '../../bench/eval/report';
import { runEval } from '../../bench/eval/run';
import { cliTools } from '../../bench/eval/tools';
import type { Condition, ModelFactory, ModelResponse, RunRecord } from '../../bench/eval/types';
import { createEnv } from '../../bench/eval/env';
import type { RunnerFactory } from '../../bench/harness/measure';
import { makeRunners, probeMcp2cli, probeMcpc } from '../../bench/harness/runners';

// Smoke tests for the agent evaluation (bench/README.md, "agent 评测"): the matcher and the judge,
// the loop with a scripted model over real replay servers for all three conditions, the
// aggregation and the report. No API key is involved. `via` runs in-process here, so no build is
// needed; the mcp2cli and mcpc conditions run only when those programs are installed.

const root = fileURLToPath(new URL('../..', import.meta.url));
const loaded: LoadedSuite = loadSuite(root);

/** In-process `via`, isolated by the sandbox's environment exactly like the spawned binary. */
const runners = (mcp2cli?: { bin: string; version: string }, mcpc?: { bin: string; version: string }): RunnerFactory => {
  const spawned = makeRunners({ viaBin: 'unused', ...(mcp2cli ? { mcp2cli } : {}), ...(mcpc ? { mcpc } : {}) });
  return (sandbox) => ({
    ...spawned(sandbox),
    via: async (argv) => {
      let stdout = '';
      let stderr = '';
      const code = await run(argv, {
        env: sandbox.env,
        cwd: sandbox.project,
        home: sandbox.home,
        platform: 'linux',
        stdout: { write: (s: string) => void (stdout += s) },
        stderr: { write: (s: string) => void (stderr += s) },
        readStdin: async () => '',
      });
      return { code, stdout, stderr };
    },
  });
};

const mcp2cli = await probeMcp2cli('mcp2cli');
const haveMcp2cli = 'version' in mcp2cli;
const mcpc = await probeMcpc('mcpc');
const haveMcpc = 'version' in mcpc;

const call = (server: string, tool: string, args: Record<string, unknown>, matched = true): LoggedCall => ({ server, tool, args, matched });

describe('matchSpec', () => {
  it('compares scalars loosely and objects as subsets', () => {
    expect(matchSpec(214, '214')).toBe(true);
    expect(matchSpec('OPEN', 'open')).toBe(true);
    expect(matchSpec({ a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(matchSpec({ a: 1 }, { b: 2 })).toBe(false);
    expect(matchSpec(['bug'], ['bug'])).toBe(true);
    expect(matchSpec(['bug'], 'bug')).toBe(true);
    expect(matchSpec(['bug'], ['bug', 'x'])).toBe(false);
  });

  it('supports the operators', () => {
    expect(matchSpec({ $contains: 'redis' }, 'Which Redis version?')).toBe(true);
    expect(matchSpec({ $contains: 'bug' }, ['Bug', 'p1'])).toBe(true);
    expect(matchSpec({ $contains: 'bug' }, 7)).toBe(false);
    expect(matchSpec({ $containsAll: ['log', 'redis'] }, 'send the logs and the Redis version')).toBe(true);
    expect(matchSpec({ $containsAll: ['log', 'redis'] }, 'send the logs')).toBe(false);
    expect(matchSpec({ $regex: '\\b487\\b' }, 'pull/487')).toBe(true);
    expect(matchSpec({ $regex: '\\b487\\b' }, 'pull/4871')).toBe(false);
    expect(matchSpec({ $oneOf: ['PLT-300', 'PLT-328'] }, 'PLT-328')).toBe(true);
    expect(matchSpec({ $not: 214 }, 223)).toBe(true);
    expect(matchSpec({ $not: { $oneOf: [1, 2] } }, 2)).toBe(false);
    expect(matchSpec({ k: { $exists: false } }, {})).toBe(true);
    expect(() => matchSpec({ $nope: 1 }, 1)).toThrow(/unknown matcher/);
  });
});

describe('judge', () => {
  const triage = loaded.tasks.find((t) => t.id === 'github-triage-bugs')!;
  const good: LoggedCall[] = [
    call('github', 'list_issues', { owner: 'acme', repo: 'api', state: 'OPEN', labels: ['bug'] }),
    call('github', 'issue_read', { method: 'get', owner: 'acme', repo: 'api', issue_number: 214 }),
    call('github', 'add_issue_comment', { owner: 'acme', repo: 'api', issue_number: 214, body: 'Please attach the logs and your Redis version.' }),
  ];

  it('every task has success criteria', () => {
    for (const task of loaded.tasks) expect(successOf(task).require.length, task.id).toBeGreaterThan(0);
  });

  it('accepts a correct run and rejects missing, forbidden, repeated and unanswered calls', () => {
    const success = successOf(triage);
    expect(judge(success, good, '').success).toBe(true);
    expect(judge(success, good.slice(0, 2), '').success).toBe(false);
    // commenting on the wrong issue is forbidden even though the replay server refused it
    expect(judge(success, [...good, call('github', 'add_issue_comment', { issue_number: 223, body: 'x' }, false)], '').success).toBe(false);
    // the same comment twice
    expect(judge(success, [...good, good[2]!], '').success).toBe(false);
    // an unanswered call does not count as done
    expect(judge(success, [good[0]!, good[1]!, { ...good[2]!, matched: false }], '').success).toBe(false);
    // wrong content
    expect(judge(success, [good[0]!, good[1]!, call('github', 'add_issue_comment', { owner: 'acme', repo: 'api', issue_number: 214, body: 'thanks' })], '').success).toBe(false);
  });

  it('checks the final answer of read-only tasks', () => {
    const find = loaded.tasks.find((t) => t.id === 'github-find-code')!;
    const calls = [
      call('github', 'search_code', { query: 'RateLimiter repo:acme/api' }),
      call('github', 'get_file_contents', { owner: 'acme', repo: 'api', path: 'src/middleware/rate_limiter.ts' }),
    ];
    expect(judge(successOf(find), calls, 'It is defined in src/middleware/rate_limiter.ts').success).toBe(true);
    expect(judge(successOf(find), calls, 'I found it.').success).toBe(false);
  });

  it('the scripted native calls of every task satisfy its criteria (the reference solution is valid)', () => {
    for (const task of loaded.tasks) {
      const log = task.native.rounds.flat().map((c) => call(c.server, c.tool, c.args));
      const answer = (task.success?.answer ?? []).map((a) => (Array.isArray(a) ? a[0] : a)).join(' ');
      const verdict = judge(successOf(task), log, answer);
      expect(verdict.checks.filter((c) => !c.ok).map((c) => c.label), task.id).toEqual([]);
    }
  });
});

describe('the evaluation loop with the scripted model', () => {
  const base = { trials: 1, maxTurns: 25, maxTokens: 4096, concurrency: 4 };

  it('runs native and via on all tasks; success, tokens, turns and calls are recorded', { timeout: 120_000 }, async () => {
    const runs = await runEval({ loaded, conditions: ['native', 'via'], ...base, runners: runners(), model: fakeModelFactory(loaded) });
    expect(runs).toHaveLength(loaded.tasks.length * 2);
    for (const r of runs) {
      expect(r.success, `${r.condition} ${r.task}: ${r.verdict.checks.filter((c) => !c.ok).map((c) => c.label).join('; ')} ${r.error ?? ''}`).toBe(true);
      expect(r.status).toBe('completed');
      expect(r.errorCalls).toBe(0);
      expect(r.tokens.input).toBeGreaterThan(0);
      expect(r.tokens.output).toBeGreaterThan(0);
      expect(r.tokens.total).toBe(r.tokens.input + r.tokens.output);
      const task = loaded.tasks.find((t) => t.id === r.task)!;
      expect(r.turns).toBe(r.condition === 'native' ? task.native.rounds.length + 1 : task.via.length + 1);
      expect(r.toolCalls).toBe(r.condition === 'native' ? task.native.rounds.flat().length : task.via.length);
    }
    // native pays for every tool definition on every turn; via does not
    const total = (c: Condition): number => runs.filter((r) => r.condition === c).reduce((n, r) => n + r.tokens.input, 0);
    expect(total('native')).toBeGreaterThan(total('via'));
  });

  it.skipIf(!haveMcp2cli)('runs the mcp2cli condition when mcp2cli is installed', { timeout: 180_000 }, async () => {
    const some = loadSuite(root, ['find-code', 'create-issue', 'dns-records']);
    const runs = await runEval({ loaded: some, conditions: ['mcp2cli'], ...base, runners: runners(haveMcp2cli ? { bin: 'mcp2cli', version: (mcp2cli as { version: string }).version } : undefined), model: fakeModelFactory(some) });
    expect(runs).toHaveLength(3);
    for (const r of runs) {
      expect(r.success, `${r.task}: ${r.verdict.checks.filter((c) => !c.ok).map((c) => c.label).join('; ')} ${r.error ?? ''}`).toBe(true);
      expect(r.errorCalls).toBe(0);
    }
  });

  // mcpc keeps a background process per session; env.close() closes them (a fake mcpc checks that in bench.test.ts).
  it.skipIf(!haveMcpc)('runs the mcpc condition (connect first) when mcpc is installed', { timeout: 180_000 }, async () => {
    const some = loadSuite(root, ['find-code', 'create-issue', 'dns-records', 'issue-to-pr']);
    const found = haveMcpc ? { bin: 'mcpc', version: (mcpc as { version: string }).version } : undefined;
    const runs = await runEval({ loaded: some, conditions: ['mcpc'], ...base, runners: runners(undefined, found), model: fakeModelFactory(some) });
    expect(runs).toHaveLength(4);
    for (const r of runs) {
      expect(r.success, `${r.task}: ${r.verdict.checks.filter((c) => !c.ok).map((c) => c.label).join('; ')} ${r.error ?? ''}`).toBe(true);
      expect(r.errorCalls).toBe(0);
      const task = some.tasks.find((t) => t.id === r.task)!;
      expect(r.toolCalls).toBe(task.mcpc!.length);
      expect(String(r.calls[0]!.input)).toMatch(/^mcpc connect /);
    }
  });

  it('aggregates, reports and labels fake output', async () => {
    const runs = await runEval({ loaded, conditions: ['native', 'via'], ...base, runners: runners(), model: fakeModelFactory(loaded) });
    const summary = summarize(runs, { conditions: ['native', 'via'], taskOrder: loaded.suite.tasks, fake: true, mcp2cliSkipped: 'not run in tests', mcpcSkipped: 'not run in tests' });
    expect(summary.conditions.map((c) => [c.condition, c.successes, c.runs])).toEqual([['native', 9, 9], ['via', 9, 9]]);
    expect(summary.tasks).toHaveLength(9);
    expect(summary.gate.evaluated).toBe(false);
    const meta: EvalMeta = { date: '2026-01-01', model: 'fake (scripted)', fake: true, trials: 1, maxTurns: 25, maxTokens: 4096, cache: false, via: '0.0.0', node: process.version, mounted: loaded.suite.mounted, tasks: loaded.suite.tasks, conditions: ['native', 'via'], mcp2cliSkipped: 'not run in tests', mcpcSkipped: 'not run in tests' };
    const outputs = [formatConsole(runs, summary, meta), formatMarkdown(runs, summary, meta), formatJson(runs, summary, meta)];
    for (const text of outputs) {
      expect(text).toContain(FAKE_BANNER.slice(0, 40));
      expect(text).not.toMatch(/via-bench-/);
      for (const t of loaded.tasks) expect(text).toContain(t.id);
    }
    expect(JSON.parse(outputs[2]!).runs).toHaveLength(18);
  });
});

describe('model misbehaviour is measured, not hidden', () => {
  const task = loaded.tasks.find((t) => t.id === 'linear-create-issue')!;
  const one = loadSuite(root, ['linear-create-issue']);
  const scripted = (respond: (turn: number) => ModelResponse): ModelFactory => () => ({
    name: 'scripted',
    create: async (req) => respond(req.messages.filter((m) => m.role === 'assistant').length),
  });
  const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 2 };
  const base = { loaded: one, conditions: ['via'] as Condition[], trials: 1, maxTokens: 1024, concurrency: 1, runners: runners() };

  it('counts bad commands as error calls and stops at the turn limit', async () => {
    const [record] = await runEval({
      ...base,
      maxTurns: 3,
      model: scripted(() => ({ content: [{ type: 'tool_use', id: 't', name: 'shell', input: { command: 'ls -la' } }], stopReason: 'tool_use', usage })),
    });
    expect(record!.status).toBe('max_turns');
    expect(record!.success).toBe(false);
    expect(record!.turns).toBe(3);
    expect(record!.errorCalls).toBe(3);
    expect(record!.calls[0]!.output).toContain('only `via` commands');
    // cache tokens are part of the input and reported separately
    expect(record!.tokens).toEqual({ input: 48, output: 15, cacheRead: 12, cacheWrite: 6, total: 63 });
  });

  it('counts a call the replay server cannot answer, and a failing API as an error run', async () => {
    const [unanswered] = await runEval({
      ...base,
      maxTurns: 4,
      model: scripted((turn) =>
        turn === 0
          ? { content: [{ type: 'tool_use', id: 't', name: 'shell', input: { command: 'via linear issue:get --id PLT-1' } }], stopReason: 'tool_use', usage }
          : { content: [{ type: 'text', text: 'gave up' }], stopReason: 'end_turn', usage },
      ),
    });
    expect(unanswered!.status).toBe('completed');
    expect(unanswered!.success).toBe(false);
    expect(unanswered!.toolCalls).toBe(1);
    expect(unanswered!.errorCalls).toBe(1);

    const [failed] = await runEval({ ...base, maxTurns: 4, model: scripted(() => Promise.reject(new Error('529 overloaded')) as never) });
    expect(failed!.status).toBe('error');
    expect(failed!.error).toContain('overloaded');
    expect(failed!.success).toBe(false);
    expect(task.id).toBe('linear-create-issue');
  });

  it('the shell tool refuses shell syntax and other programs', async () => {
    const env = await createEnv({ loaded: one, task, condition: 'via', runners: runners() });
    try {
      const tools = cliTools('via', env.runners!.via, env);
      for (const command of ['via linear | head', 'via linear && ls', 'cat /etc/passwd', 'via "oops']) {
        const result = await tools.call('shell', { command });
        expect(result.isError, command).toBe(true);
        expect(result.text, command).toContain('[exit code: 127]');
      }
      const ok = await tools.call('shell', { command: 'via linear' });
      expect(ok.isError).toBe(false);
      expect(ok.text).toContain('[exit code: 0]');
      const login = await tools.call('shell', { command: 'via auth login linear' });
      expect(login.isError).toBe(true);
      expect(login.text).toContain('authentication is checked before the run');
      expect(login.text).toContain('[exit code: 127]');
      expect(env.calls()).toEqual([]);
    } finally {
      await env.close();
    }
  });

  it('checks configured logins before a run and refuses another login or a foreign server during it', async () => {
    expect(needsInteractiveLogin({ provider: 'notion', method: 'oauth', state: 'not logged in' })).toBe(true);
    expect(needsInteractiveLogin({ provider: 'linear', method: 'oauth', state: 'access token expired (refreshes on next call)' })).toBe(false);
    expect(authUnusable({ provider: 'github', method: 'bearer', state: 'missing env:TOKEN' })).toBe(true);
    expect(authUnusable({ provider: 'playwright', method: 'none', state: 'no credentials' })).toBe(false);

    const replay = ['http://127.0.0.1:9/mcp'];
    expect(rejectAuthCommand('via', ['via', 'auth', 'login', 'linear'], replay)).toMatch(/via auth/);
    expect(rejectAuthCommand('mcp2cli', ['mcp2cli', '--oauth', '@linear'], replay)).toMatch(/--oauth/);
    expect(rejectAuthCommand('mcpc', ['mcpc', 'login', 'notion'], replay)).toMatch(/mcpc login/);
    expect(rejectAuthCommand('mcpc', ['mcpc', 'connect', 'https://mcp.notion.com/mcp', '@notion'], replay)).toMatch(/not a replay server/);
    expect(rejectAuthCommand('mcpc', ['mcpc', 'connect', './mcp.json:notion', '@notion'], replay)).toBeUndefined();
    expect(rejectAuthCommand('mcp2cli', ['mcp2cli', '--mcp', 'https://mcp.linear.app/mcp', '--list'], replay)).toMatch(/not a replay server/);
    expect(rejectAuthCommand('mcp2cli', ['mcp2cli', '@playwright', 'browser-navigate', '--url', 'https://docs.acme.test/'], replay)).toBeUndefined();
    expect(rejectAuthCommand('via', ['via', 'playwright', 'browser:navigate', '--url', 'https://docs.acme.test/'], replay)).toBeUndefined();

    const calls: string[][] = [];
    const lines: string[] = [];
    await preflightAuth({
      providers: ['linear', 'notion', 'playwright'],
      log: (line) => lines.push(line),
      run: async (args) => {
        calls.push(args);
        if (args[1] === 'status' && args[2] === '-o') {
          return {
            code: 0,
            stdout: JSON.stringify([
              { provider: 'linear', method: 'oauth', state: 'logged in, expires in 1h' },
              { provider: 'notion', method: 'oauth', state: 'not logged in' },
              { provider: 'playwright', method: 'none', state: 'no credentials' },
            ]),
            stderr: '',
          };
        }
        if (args[1] === 'login') return { code: 0, stdout: 'logged in: notion\n', stderr: '' };
        return { code: 0, stdout: JSON.stringify([{ provider: 'notion', method: 'oauth', state: 'logged in' }]), stderr: '' };
      },
    });
    expect(calls).toContainEqual(['auth', 'login', 'notion']);
    expect(calls.some((args) => args[1] === 'login' && args[2] === 'linear')).toBe(false);
    expect(lines.some((line) => line.includes('playwright') && line.includes('no credentials'))).toBe(true);
    expect(lines.some((line) => line.includes('notion ok'))).toBe(true);
  });
});

describe('prompts', () => {
  it('share the common part and differ only in the condition section', () => {
    const parts = { mounted: ['github', 'linear'], viaPrompt: 'VIA TEXT', mcp2cliSkill: 'SKILL TEXT', mcpcSkill: 'MCPC TEXT' };
    const native = buildSystemPrompt('native', parts);
    const via = buildSystemPrompt('via', parts);
    const m = buildSystemPrompt('mcp2cli', parts);
    expect(via.startsWith(native)).toBe(true);
    expect(m.startsWith(native)).toBe(true);
    expect(via).toContain('VIA TEXT');
    expect(m).toContain('SKILL TEXT');
    expect(m).toContain('Servers: @github @linear');
    const c = buildSystemPrompt('mcpc', parts);
    expect(c.startsWith(native)).toBe(true);
    expect(c).toContain('runs `mcpc` commands');
    expect(c).toContain('MCPC TEXT');
    expect(c).toContain('Servers (entries of ./mcp.json, not connected yet): github linear');
    expect(c).not.toContain('SKILL TEXT');
    expect(() => buildSystemPrompt('mcpc', { mounted: [] })).toThrow(/mcpc skill/);
    expect(() => buildSystemPrompt('via', { mounted: [] })).toThrow();
  });
});

describe('aggregation and the gate', () => {
  it('computes medians and Wilson intervals', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    const [lo, hi] = wilson(9, 9);
    expect(lo).toBeGreaterThan(0.6);
    expect(hi).toBe(1);
    expect(wilson(0, 0)).toEqual([0, 0]);
  });

  const record = (condition: Condition, success: boolean, trial: number): RunRecord => ({
    task: 't', condition, trial, status: 'completed', success, verdict: { success, checks: [] }, turns: 2, toolCalls: 1, errorCalls: 0,
    tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, total: 110 }, wallMs: 1000, finalText: '', calls: [],
  });
  const many = (condition: Condition, successes: number, n: number): RunRecord[] => Array.from({ length: n }, (_, i) => record(condition, i < successes, i + 1));

  it('holds when via is not lower than native and mcp2cli, and says when it is not evaluated', () => {
    const runs = [...many('native', 8, 10), ...many('via', 9, 10), ...many('mcp2cli', 7, 10)];
    const conds = (['native', 'via', 'mcp2cli'] as Condition[]).map((c) => summarizeCondition(c, runs));
    const gate = gateOf(conds, { fake: false });
    expect(gate).toMatchObject({ evaluated: true, complete: true, holds: true });
    expect(gate.comparisons.map((c) => [c.versus, c.holds])).toEqual([['native', true], ['mcp2cli', true]]);

    const worse = gateOf((['native', 'via', 'mcp2cli'] as Condition[]).map((c) => summarizeCondition(c, [...many('native', 10, 10), ...many('via', 6, 10), ...many('mcp2cli', 7, 10)])), { fake: false });
    expect(worse.holds).toBe(false);

    const partial = gateOf((['native', 'via'] as Condition[]).map((c) => summarizeCondition(c, runs)), { fake: false, mcp2cliSkipped: 'not installed' });
    expect(partial).toMatchObject({ evaluated: true, complete: false, holds: true });
    expect(partial.notes.join(' ')).toContain('not installed');

    expect(gateOf(conds, { fake: true }).evaluated).toBe(false);
  });

  it('reports via against mcpc next to the gate without letting it decide the gate', () => {
    const all: Condition[] = ['native', 'via', 'mcp2cli', 'mcpc'];
    const runs = [...many('native', 8, 10), ...many('via', 7, 10), ...many('mcp2cli', 6, 10), ...many('mcpc', 9, 10)];
    const summary = summarize(runs, { conditions: all, taskOrder: ['t'], fake: false });
    // via is below mcpc, but the gate asks only for native and mcp2cli
    expect(summary.gate.comparisons.map((c) => c.versus)).toEqual(['native', 'mcp2cli']);
    expect(summary.gate.holds).toBe(false);
    expect(summary.extra.map((c) => [c.versus, c.holds])).toEqual([['mcpc', false]]);

    const ahead = summarize([...many('via', 9, 10), ...many('mcpc', 5, 10)], { conditions: ['via', 'mcpc'], taskOrder: ['t'], fake: false });
    expect(ahead.extra.map((c) => [c.versus, c.holds])).toEqual([['mcpc', true]]);
    // a scripted model, or no mcpc runs, gives no comparison
    expect(summarize(runs, { conditions: all, taskOrder: ['t'], fake: true }).extra).toEqual([]);
    expect(summarize(many('via', 9, 10), { conditions: ['via'], taskOrder: ['t'], fake: false }).extra).toEqual([]);
  });
});

describe('bench:eval command', () => {
  const io = () => {
    const out = { stdout: '', stderr: '' };
    return { out, io: { stdout: (s: string) => void (out.stdout += s), stderr: (s: string) => void (out.stderr += s) } };
  };

  it('parses the options', () => {
    const args = parseArgs(['--trials', '5', '--task', 'dns', '--condition', 'via,native', '--model', 'm', '--max-turns', '9', '--concurrency', '2', '--effort', 'low', '--cache', '--fake-model', '--no-mcp2cli']);
    expect(args).toMatchObject({ trials: 5, tasks: ['dns'], conditions: ['via', 'native'], model: 'm', maxTurns: 9, concurrency: 2, effort: 'low', cache: true, fake: true, mcp2cli: false });
    expect(parseArgs([]).conditions).toEqual(['native', 'via', 'mcp2cli', 'mcpc']);
    expect(parseArgs([]).mcpc).toBe('mcpc');
    expect(parseArgs(['--no-mcpc'])).toMatchObject({ mcpc: false });
    expect(parseArgs(['--mcpc', '/opt/bin/mcpc', '--condition', 'mcpc'])).toMatchObject({ mcpc: '/opt/bin/mcpc', conditions: ['mcpc'] });
    expect(() => parseArgs(['--condition', 'bash'])).toThrow(/unknown condition/);
    expect(() => parseArgs(['--trials', '0'])).toThrow();
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
  });

  it('refuses to run without an API key and explains how to proceed', async () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      const { out, io: sink } = io();
      expect(await main([], sink)).toBe(2);
      expect(out.stderr).toContain('ANTHROPIC_API_KEY');
      expect(out.stderr).toContain('--fake-model');
      expect(out.stdout).toBe('');
    } finally {
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
    }
  });

  it('never writes scripted-model output under bench/results/, and labels it elsewhere', { timeout: 120_000 }, async () => {
    const { io: sink } = io();
    await expect(main(['--fake-model', '--out', 'bench/results/eval-fake'], sink)).rejects.toThrow(/must not go under bench\/results/);

    const dir = mkdtempSync(join(tmpdir(), 'via-eval-test-'));
    try {
      const { out, io: sink2 } = io();
      // dist/via.js is not needed when only native runs; mcp2cli and via are left out
      const code = await main(['--fake-model', '--condition', 'native', '--task', 'dns-records', '--out', join(dir, 'fake')], sink2);
      expect(code).toBe(0);
      expect(out.stdout).toContain(FAKE_BANNER.slice(0, 40));
      const json = JSON.parse(readFileSync(join(dir, 'fake.json'), 'utf8')) as { notice: string; meta: { fake: boolean }; runs: unknown[] };
      expect(json.notice).toBe(FAKE_BANNER);
      expect(json.meta.fake).toBe(true);
      expect(json.runs).toHaveLength(3);
      expect(readFileSync(join(dir, 'fake.md'), 'utf8')).toContain(FAKE_BANNER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
