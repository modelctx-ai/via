import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { run } from '../../src/cli/run';
import { cannedCalls, matchArgs, readTools, startReplayHttp } from '../../bench/replay-server.mjs';
import type { Exec } from '../../bench/harness/exec';
import { checkTask, loadSuite, type LoadedSuite } from '../../bench/harness/load';
import { measureSuite, runSession, type RunnerFactory } from '../../bench/harness/measure';
import { formatConsole, formatJson, formatMarkdown } from '../../bench/harness/report';
import { splitCommand } from '../../bench/harness/shell';
import { estimateTokens } from '../../bench/harness/tokens';
import type { Task } from '../../bench/harness/types';

// Smoke tests for the token benchmark (bench/README.md): the task files are valid, every scripted
// via command resolves against the fixture catalog and exits as expected, the replay server answers,
// and via makes the same tool calls as the native column. via runs in-process here, so no build
// is needed; `npm run bench:tokens` runs the built binary.

const root = fileURLToPath(new URL('../..', import.meta.url));

describe('splitCommand', () => {
  it('splits like a POSIX shell without running one', () => {
    expect(splitCommand(`via github issue:list --repo "a b" --body 'it''s' x\\ y`)).toEqual(['via', 'github', 'issue:list', '--repo', 'a b', '--body', 'its', 'x y']);
    expect(splitCommand(`mcp2cli @gh --labels '["bug"]' --q "say \\"hi\\""`)).toEqual(['mcp2cli', '@gh', '--labels', '["bug"]', '--q', 'say "hi"']);
    expect(splitCommand('a "" b')).toEqual(['a', '', 'b']);
  });

  it('rejects an unterminated quote', () => {
    expect(() => splitCommand('via "oops')).toThrow(/unterminated/);
  });
});

describe('suite files', () => {
  let loaded: LoadedSuite;
  it('load and validate against the JSON Schemas', () => {
    loaded = loadSuite(root);
    expect(loaded.tasks.map((t) => t.id)).toEqual(loaded.suite.tasks);
    for (const server of ['github', 'linear', 'notion', 'playwright', 'cloudflare']) expect(loaded.suite.mounted).toContain(server);
    for (const task of loaded.tasks) {
      expect(task.via.length, task.id).toBeGreaterThan(0);
      expect(task.mcp2cli?.length, task.id).toBeGreaterThan(0);
    }
  });

  it('reports problems the schema and the cross-file rules catch', () => {
    loaded = loadSuite(root);
    const base = loaded.tasks.find((t) => t.id === 'github-triage-bugs')!;
    const mutate = (change: (t: Task) => void): string[] => {
      const copy = structuredClone(base);
      change(copy);
      return checkTask(loaded, copy);
    };
    expect(checkTask(loaded, base)).toEqual([]);
    expect(mutate((t) => void (t.native.rounds[0]![0]!.tool = 'list_nothing'))).toEqual(expect.arrayContaining([expect.stringContaining('has no tool list_nothing')]));
    // issue_read requires `method`; the native arguments are validated against the tool's inputSchema
    expect(mutate((t) => void delete t.native.rounds[1]![0]!.args.method)).toEqual(expect.arrayContaining([expect.stringContaining("must have required property 'method'")]));
    expect(mutate((t) => void (t.calls = t.calls.slice(1)))).toEqual(expect.arrayContaining([expect.stringContaining('has no entry in calls')]));
    expect(mutate((t) => void (t.via[0]!.run = 'mcp2cli @github --list'))).toEqual(expect.arrayContaining([expect.stringContaining('must start with `via`')]));
    expect(mutate((t) => void (t.servers = ['linear']))).toEqual(expect.arrayContaining([expect.stringContaining('not listed in servers')]));
    expect(mutate((t) => void (t.calls[0]!.resultFile = 'recordings/missing.json'))).toEqual(expect.arrayContaining([expect.stringContaining('not found')]));
  });
});

describe('replay server', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function connect(url: string): Promise<Client> {
    const client = new Client({ name: 'bench-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    closers.push(() => client.close());
    return client;
  }

  it('matches arguments by subset', () => {
    expect(matchArgs({ method: 'get' }, { method: 'get', owner: 'acme' })).toBe(true);
    expect(matchArgs({ method: 'get' }, { method: 'get_files' })).toBe(false);
    expect(matchArgs({ labels: ['bug'] }, { labels: ['bug', 'x'] })).toBe(false);
    expect(matchArgs({ a: { b: 1 } }, { a: { b: 1, c: 2 } })).toBe(true);
  });

  it('serves the fixture tools/list and the canned results, and fails everything else with isError', async () => {
    const tools = readTools(`${root}test/fixtures/tools/linear.json`);
    const task = loadSuite(root, ['linear-my-work']).tasks[0]!;
    const calls = cannedCalls([task], 'linear', `${root}bench`);
    const running = await startReplayHttp({ name: 'linear', tools, calls });
    closers.push(running.close);
    const client = await connect(running.url);

    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(tools.map((t) => t.name));

    const ok = await client.callTool({ name: 'get_issue', arguments: { id: 'PLT-300' } });
    expect(ok.isError).toBeFalsy();
    const text = (ok.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(JSON.parse(text).identifier).toBe('PLT-300');

    const unknown = await client.callTool({ name: 'no_such_tool', arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.content)).toContain('unknown tool: no_such_tool');

    // A tool the fixture has but the task has no canned result for.
    const uncanned = await client.callTool({ name: 'list_teams', arguments: { query: 'x' } });
    expect(uncanned.isError).toBe(true);
    expect(JSON.stringify(uncanned.content)).toContain('no canned result for list_teams');

    // The call log is available in-process and over HTTP.
    expect(running.log.map((e) => [e.tool, e.matched])).toEqual([['get_issue', true], ['no_such_tool', false], ['list_teams', false]]);
    const over = (await (await fetch(running.url.replace(/\/mcp$/, '/__replay/calls'))).json()) as Array<{ tool: string }>;
    expect(over.map((e) => e.tool)).toEqual(['get_issue', 'no_such_tool', 'list_teams']);
  });

  it('can be re-targeted while running (the benchmark swaps canned calls per task)', async () => {
    const tools = readTools(`${root}test/fixtures/tools/cloudflare.json`);
    const calls = [{ tool: 'whoami', result: { content: [{ type: 'text', text: 'first' }] } }];
    const running = await startReplayHttp({ name: 'cloudflare', tools, calls });
    closers.push(running.close);
    const client = await connect(running.url);
    expect(JSON.stringify((await client.callTool({ name: 'whoami', arguments: {} })).content)).toContain('first');
    calls.splice(0, 1, { tool: 'whoami', result: { content: [{ type: 'text', text: 'second' }] } });
    expect(JSON.stringify((await client.callTool({ name: 'whoami', arguments: {} })).content)).toContain('second');
  });
});

describe('runSession', () => {
  const ok = (stdout: string, stderr = ''): Exec => async () => ({ code: 0, stdout, stderr });

  it('counts command text, stdout and stderr, and feeds a printed cursor to {cursor}', async () => {
    const seen: string[][] = [];
    const exec: Exec = async (args) => {
      seen.push(args);
      return args[0] === 'more' ? { code: 0, stdout: 'rest\n', stderr: '' } : { code: 0, stdout: 'abc\n', stderr: '· p · 100ms · next: via more c7f2\n' };
    };
    const steps = await runSession('t', 'via', [{ run: 'via p t:list' }, { run: 'via more {cursor}' }], exec, '/tmp/x');
    expect(seen).toEqual([['p', 't:list'], ['more', 'c7f2']]);
    expect(steps[0]).toMatchObject({ command: 'via p t:list', commandBytes: 12, stdoutBytes: 4 });
    expect(steps[1]!.command).toBe('via more c7f2');
  });

  it('fails on a missing cursor, an unexpected exit code and the wrong program', async () => {
    await expect(runSession('t', 'via', [{ run: 'via more {cursor}' }], ok('x'), '/tmp/x')).rejects.toThrow(/needs a cursor/);
    await expect(runSession('t', 'via', [{ run: 'via nothing' }], async () => ({ code: 3, stdout: '', stderr: 'error: no such provider' }), '/tmp/x')).rejects.toThrow(/exited 3, expected 0/);
    await expect(runSession('t', 'via', [{ run: 'via nothing', exit: 3 }], async () => ({ code: 3, stdout: '', stderr: '' }), '/tmp/x')).resolves.toHaveLength(1);
    await expect(runSession('t', 'via', [{ run: 'mcp2cli --list' }], ok(''), '/tmp/x')).rejects.toThrow(/must run via/);
  });
});

describe('the scripted tasks against the real CLI code', () => {
  it('every via command resolves, exits as scripted and makes the same tool calls as native', { timeout: 120_000 }, async () => {
    const loaded = loadSuite(root);
    // In-process `run`, isolated by the sandbox's environment exactly like the spawned binary.
    const runners: RunnerFactory = (sandbox) => ({
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
    const measure = await measureSuite({ loaded, runners });

    expect(measure.tasks.map((t) => t.id)).toEqual(loaded.suite.tasks);
    for (const t of measure.tasks) {
      const task = loaded.tasks.find((x) => x.id === t.id)!;
      expect(t.via.steps.map((s) => s.command.split(' ')[0]), t.id).toEqual(task.via.map(() => 'via'));
      expect(t.via.steps.every((s) => s.stdoutBytes + s.stderrBytes > 0), t.id).toBe(true);
      expect(t.native.turns, t.id).toBe(task.native.rounds.length + 1);
      expect(t.native.totalBytes, t.id).toBeGreaterThan(t.native.injectionBytes * t.native.turns);
    }
    expect(measure.viaPromptBytes).toBeGreaterThan(0);
    expect(measure.mcp2cli).toBeUndefined();

    // The reports render and stay free of the sandbox's paths and ports.
    const meta = { via: '0.0.0', node: process.version, mounted: loaded.suite.mounted, mcp2cliSkipped: 'not run in tests' };
    const outputs = [formatConsole(measure, meta), formatMarkdown(measure, meta, 'test'), formatJson(measure, meta)];
    for (const text of outputs) {
      expect(text).not.toMatch(/via-bench-/);
      for (const t of loaded.tasks) expect(text).toContain(t.id);
    }
    expect(JSON.parse(outputs[2]!).totals.native).toBe(measure.tasks.reduce((n, t) => n + estimateTokens(t.native.totalBytes), 0));
  });
});
