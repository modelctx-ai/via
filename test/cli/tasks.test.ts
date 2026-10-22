// Tasks, both generations of the protocol (cli.md, "任务"; ADR 0020), in-process; the daemon path is in
// test/daemon/tasks.test.ts. `report_job` takes `--ms` (how long the job runs) and `--mode`; the old protocol
// makes a task when the client asks (the tool requires one, or `--detach`), the stateless one when the server decides.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN, ghConfig, makeSandbox, normalize, startFixtureServer, useCleanup, type Generation } from './helpers';

async function setup(protocol: Generation, features: Array<'tasks' | 'tasks-nolist'> = ['tasks']) {
  const srv = await startFixtureServer({ token: FAKE_TOKEN, features, protocol });
  useCleanup(() => srv.close());
  const sb = makeSandbox();
  sb.userConfig(ghConfig(srv.url));
  return { srv, sb };
}

const detach = (sb: Awaited<ReturnType<typeof setup>>['sb'], args: string[]) => sb.via(['gh', '--detach', ...args]);

describe.each(['legacy', 'modern'] as const)('tasks on the %s protocol', (protocol) => {
  const detachArgs = ['report_job', '--ms', '600'];

  it('follows a task to its result without a trace of it in stdout', async () => {
    const { sb } = await setup(protocol);
    // The old protocol asks for a task only for a tool that requires one; the stateless one lets the server decide.
    const r = await sb.via(['gh', protocol === 'legacy' ? 'must_task' : 'report_job', '--ms', '200']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('report ready after 200ms\n');
    expect(r.stderr).toContain('progress: task gh/job/1 working\n');
    expect(r.stderr).toMatch(/· gh (must-task|report-job)|· gh must_task|· gh report_job/);
  });

  it('answers a call at once when no task is needed', async () => {
    const { srv, sb } = await setup(protocol);
    const r = await sb.via(['gh', 'report_job', '--ms', '0']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('report ready after 0ms\n');
    expect(r.stderr).not.toContain('task');
    expect(srv.state.tasks.size).toBe(0);
  });

  it('--detach prints the provider-prefixed id, the status and the command that continues', async () => {
    const { sb } = await setup(protocol);
    const r = await detach(sb, detachArgs);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('task: gh/job/1\nstatus: working\n');
    expect(normalize(r.stderr)).toMatch(/^progress: task gh\/job\/1 working\n· gh report[-_]job · <t> · \d+ bytes · next: via tasks gh job\/1\n$/);
  });

  it('waits for a detached task with the prefixed or the two-word id and prints the result', async () => {
    const { sb } = await setup(protocol);
    await detach(sb, detachArgs);
    const two = await sb.via(['tasks', 'gh', 'job/1']);
    expect(two.code).toBe(0);
    expect(two.stdout).toBe('report ready after 600ms\n');
    const one = await sb.via(['tasks', 'gh/job/1']);
    expect(one.stdout).toBe('report ready after 600ms\n');
    expect(one.stderr).toMatch(/^· tasks gh · \d+ms · 25 bytes\n$/);
  });

  it('reports the state with --status without waiting', async () => {
    const { sb } = await setup(protocol);
    await detach(sb, ['report_job', '--ms', '5000']);
    const r = await sb.via(['tasks', 'gh', 'job/1', '--status']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^task: gh\/job\/1\nstatus: working\n/);
    expect(JSON.parse((await sb.via(['tasks', 'gh', 'job/1', '--status', '-o', 'json'])).stdout)).toMatchObject({ task: 'gh/job/1', status: 'working' });
  });

  it('stops waiting at --timeout, leaves the task running and names the command that continues', async () => {
    const { sb } = await setup(protocol);
    const r = await sb.via(['gh', 'must_task', '--ms', '5000', '--timeout', '0.5']);
    if (protocol === 'modern') {
      // The same tool, on the stateless protocol, as a task made by the server.
      expect(r.code).toBe(6);
    }
    expect(r.code).toBe(6);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('error: still running as task gh/job/1 after 0.5s; it was not cancelled\nnext: via tasks gh job/1\n');
    // It runs on: the same task is there to be asked.
    expect((await sb.via(['tasks', 'gh', 'job/1', '--status'])).stdout).toContain('status: working');
    const waited = await sb.via(['tasks', 'gh', 'job/1', '--timeout', '0.2']);
    expect(waited.code).toBe(6);
    expect(waited.stderr).toContain('next: via tasks gh job/1\n');
  });

  it('shows a failed task as a failed tool, and a cancelled one too', async () => {
    const { sb } = await setup(protocol);
    await detach(sb, ['report_job', '--ms', '150', '--mode', 'fail']);
    const failed = await sb.via(['tasks', 'gh', 'job/1']);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toMatch(/^error: job failed\n/);

    await detach(sb, ['report_job', '--ms', '5000']);
    const cancel = await sb.via(['tasks', 'gh', 'job/2', '--cancel']);
    expect(cancel.code).toBe(0);
    expect(cancel.stdout).toMatch(/^task: gh\/job\/2\nstatus: cancelled\n/);
    const after = await sb.via(['tasks', 'gh', 'job/2']);
    expect(after.code).toBe(1);
    expect(after.stderr).toMatch(/^error: task was cancelled/);
  });

  it('says a cancellation the server only acknowledged is pending, and refuses to cancel a task that ended', async () => {
    const { sb } = await setup(protocol);
    await detach(sb, ['report_job', '--ms', '5000', '--mode', 'stubborn']);
    const pending = await sb.via(['tasks', 'gh', 'job/1', '--cancel']);
    expect(pending.code).toBe(0);
    expect(pending.stdout).toContain('status: working');
    expect(pending.stdout).toContain('note: cancellation requested; the server still reports the task as running');

    await detach(sb, ['report_job', '--ms', '100']);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const late = await sb.via(['tasks', 'gh', 'job/2', '--cancel']);
    expect(late.code).toBe(1);
    expect(late.stderr).toContain('error: gh/job/2 was not cancelled: it already completed\nnext: via tasks gh job/2\n');
  });

  it('does not answer a task that waits for input: it says so and leaves the task alone', async () => {
    const { sb } = await setup(protocol);
    await detach(sb, ['report_job', '--ms', '100', '--mode', 'input']);
    const r = await sb.via(['tasks', 'gh', 'job/1']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^error: gh\/job\/1 is waiting for input( \(elicitation\/create\))?, which via cannot give\nnext: via tasks gh job\/1 --cancel\n$/);
    if (protocol === 'modern') expect(r.stderr).toContain('(elicitation/create)');
  });

  it('lists the tasks, from the server where it keeps a list and from via’s own record where it does not', async () => {
    const { sb } = await setup(protocol);
    await detach(sb, ['report_job', '--ms', '5000']);
    await detach(sb, ['report_job', '--ms', '100', '--mode', 'fail']);
    const r = await sb.via(['tasks', 'gh']);
    expect(r.code).toBe(0);
    const lines = r.stdout.split('\n');
    expect(lines.find((l) => l.startsWith('gh/job/1'))).toMatch(/^gh\/job\/1\s+working\s+gh report[-_:a-z]*job\s+\S+/);
    expect(lines.find((l) => l.startsWith('gh/job/2'))).toMatch(/^gh\/job\/2\s+(working|failed)\s+/);
    if (protocol === 'modern') expect(r.stdout).toContain('(this server keeps no task list; these are the tasks via started)');
    const json = JSON.parse((await sb.via(['tasks', 'gh', '-o', 'json'])).stdout) as { source: string; tasks: Array<{ ref: string }> };
    expect(json.source).toBe(protocol === 'modern' ? 'record' : 'server');
    expect(json.tasks.map((t) => t.ref).sort()).toEqual(['gh/job/1', 'gh/job/2']);
  });

  it('lists from the record when an old-protocol server has no listing', async () => {
    const { sb } = await setup(protocol, ['tasks-nolist']);
    await detach(sb, ['report_job', '--ms', '5000']);
    const json = JSON.parse((await sb.via(['tasks', 'gh', '-o', 'json'])).stdout) as { source: string; tasks: Array<{ ref: string; tool: string }> };
    expect(json.source).toBe('record');
    expect(json.tasks[0]).toMatchObject({ ref: 'gh/job/1' });
  });

  it('marks a recorded task the server no longer knows as expired and forgets it', async () => {
    const { srv, sb } = await setup(protocol, ['tasks-nolist']);
    await detach(sb, ['report_job', '--ms', '5000']);
    srv.state.tasks.clear();
    const r = await sb.via(['tasks', 'gh']);
    expect(r.stdout).toMatch(/^gh\/job\/1\s+expired\s+/);
    expect(JSON.parse((await sb.via(['tasks', 'gh', '-o', 'json'])).stdout)).toEqual({ source: 'record' });
    const unknown = await sb.via(['tasks', 'gh', 'job/1']);
    expect(unknown.code).toBe(3);
    expect(unknown.stderr).toBe('error: no such task: job/1 (it may have expired)\nnext: via tasks gh\n');
  });

  it('records a task with its tool and times, and nothing else', async () => {
    const { sb } = await setup(protocol);
    await detach(sb, ['report_job', '--ms', '5000', '--mode', 'ok']);
    const root = join(sb.cacheDir, 'tasks');
    expect(existsSync(root)).toBe(true);
    const folder = join(root, readdirSync(root)[0]!);
    const files = readdirSync(folder);
    expect(files).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(folder, files[0]!), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(['createdAt', 'id', 'status', 'tool', 'version']);
    expect(record).toMatchObject({ id: 'job/1', version: 1 });
    expect(String(record.tool)).toMatch(/^gh report[-_:a-z]*job$/);
  });
});

describe('--detach', () => {
  it('on the old protocol needs a tool that allows a task and a server that supports them', async () => {
    const { srv, sb } = await setup('legacy');
    const forbidden = await sb.via(['gh', '--detach', 'issue_read', '--owner', 'a', '--repo', 'b', '--issue-number', '1', '--method', 'get']);
    expect(forbidden.code).toBe(2);
    expect(forbidden.stderr).toBe('error: cannot detach: the tool declares no task support (execution.taskSupport: forbidden)\nnext: rerun without --detach\n');
    expect(srv.state.calls).toEqual([]);

    const bare = await startFixtureServer({ token: FAKE_TOKEN, protocol: 'legacy' });
    useCleanup(() => bare.close());
    const sb2 = makeSandbox();
    sb2.userConfig(ghConfig(bare.url));
    const none = await sb2.via(['gh', '--detach', 'echo_text', '--message', 'x']);
    expect(none.code).toBe(2);
    expect(none.stderr).toBe('error: cannot detach: gh did not declare support for tasks on tool calls\nnext: rerun without --detach\n');
  });

  it('on the stateless protocol needs the extension; a server that answers at once gives the result', async () => {
    const bare = await startFixtureServer({ token: FAKE_TOKEN, protocol: 'modern' });
    useCleanup(() => bare.close());
    const sb2 = makeSandbox();
    sb2.userConfig(ghConfig(bare.url));
    const none = await sb2.via(['gh', '--detach', 'echo_text', '--message', 'x']);
    expect(none.code).toBe(2);
    expect(none.stderr).toBe('error: cannot detach: gh did not declare the io.modelcontextprotocol/tasks extension\nnext: rerun without --detach\n');

    const { sb } = await setup('modern');
    const quick = await sb.via(['gh', '--detach', 'report_job', '--ms', '0']);
    expect(quick.code).toBe(0);
    expect(quick.stdout).toBe('report ready after 0ms\n');
    expect(quick.stderr).toMatch(/· gh report[-_]job · \d+ms · 23 bytes · no task\n$/);
  });

  it('is refused where there is no tool call', async () => {
    const { sb } = await setup('modern');
    for (const argv of [['gh', '--detach'], ['gh', 'issue', '--detach'], ['find', 'issue', '--detach'], ['--detach'], ['tasks', 'gh', '--detach']]) {
      const r = await sb.via(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.stderr).toContain('--detach applies to a tool call');
    }
  });
});

describe('via tasks', () => {
  it('says a server without tasks has none, without asking it', async () => {
    const { srv, sb } = await setup('modern', []);
    const r = await sb.via(['tasks', 'gh']);
    expect(r.code).toBe(3);
    expect(r.stderr).toBe('error: gh does not offer MCP tasks: it did not declare the io.modelcontextprotocol/tasks extension\nnext: via gh\n');
    expect(srv.state.taskRequests).toEqual([]);
    const old = await setup('legacy', []);
    expect((await old.sb.via(['tasks', 'gh'])).stderr).toBe('error: gh does not offer MCP tasks: it did not declare the tasks capability\nnext: via gh\n');
  });

  it('has a usage, takes at most a provider and an id, and has two exclusive flags', async () => {
    const { sb } = await setup('modern');
    expect((await sb.via(['tasks'])).stderr).toBe('error: usage: via tasks <provider> [<task-id>] [--status | --cancel]\nnext: via tasks -h\n');
    expect((await sb.via(['tasks', 'gh', 'a', 'b'])).code).toBe(2);
    expect((await sb.via(['tasks', 'gh', 'a', '--status', '--cancel'])).code).toBe(2);
    expect((await sb.via(['tasks', 'gh', '--cancel'])).stderr).toContain('--cancel needs a task id');
    expect((await sb.via(['tasks', 'gh', '--bogus'])).stderr).toContain('unknown option --bogus');
    expect((await sb.via(['tasks', '-h'])).stdout).toContain('usage: via tasks <provider>');
  });

  it('reserves tasks as a provider name', async () => {
    const sb = makeSandbox();
    sb.userConfig('sources: false\nservers:\n  tasks:\n    url: http://127.0.0.1:1/mcp\n');
    expect((await sb.via([])).stdout).toContain('0 providers');
  });
});
