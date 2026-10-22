// Tasks through a real daemon, over a stdio server of each generation: the `task` event reaches the CLI (so the
// record and the `progress:` line exist even while the call is still being followed), `--detach` and `via tasks` work
// on the daemon's session (ADR 0020; daemon.md).
import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN } from '../cli/helpers';
import { daemonSandbox } from '../helpers/daemon';
import { fixtureScript, type Generation } from '../helpers/generation';

const config = (generation: Generation) =>
  `sources: false\nservers:\n  fs:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(fixtureScript('cli-stdio-server', generation))}]\n    env: { CLI_FIXTURE_FEATURES: "tasks,elicit" }\n`;

describe.each(['legacy', 'modern'] as const)('tasks through the daemon, %s protocol', (generation) => {
  it('follows a call, detaches, waits, lists and cancels', async () => {
    const d = await daemonSandbox(config(generation), { GH_TOKEN: FAKE_TOKEN });

    const followed = await d.via(['fs', generation === 'legacy' ? 'must_task' : 'report_job', '--ms', '200']);
    expect(followed.code).toBe(0);
    expect(followed.stdout).toBe('report ready after 200ms\n');
    expect(followed.stderr).toContain('progress: task fs/job/1 working\n');

    const detached = await d.via(['fs', '--detach', 'report_job', '--ms', '600']);
    expect(detached.stdout).toBe('task: fs/job/2\nstatus: working\n');
    expect(detached.stderr).toContain('next: via tasks fs job/2\n');

    const waited = await d.via(['tasks', 'fs', 'job/2']);
    expect(waited.code).toBe(0);
    expect(waited.stdout).toBe('report ready after 600ms\n');

    await d.via(['fs', '--detach', 'report_job', '--ms', '5000']);
    const listed = await d.via(['tasks', 'fs']);
    expect(listed.stdout).toMatch(/fs\/job\/3\s+working\s+fs report[-_:a-z]*job/);
    const cancelled = await d.via(['tasks', 'fs', 'job/3', '--cancel']);
    expect(cancelled.stdout).toContain('status: cancelled');
  });

  it('keeps the daemon’s session when the wait runs out: the task is still there afterwards', async () => {
    const d = await daemonSandbox(config(generation), { GH_TOKEN: FAKE_TOKEN });
    await d.via(['fs', 'report_job', '--ms', '0']); // connect first: the timeout below is for the task, not for starting the server
    const slow = await d.via(['fs', 'must_task', '--ms', '5000', '--timeout', '0.5']);
    expect(slow.code).toBe(6);
    expect(slow.stderr).toContain('error: still running as task fs/job/1 after 0.5s; it was not cancelled\nnext: via tasks fs job/1\n');
    expect((await d.via(['tasks', 'fs', 'job/1', '--status'])).stdout).toContain('status: working');
  });

  // A task in `input_required` asks the person behind the command that waits for it, through the daemon: an `elicit`
  // event to that CLI and its `elicit-reply` back (daemon.md, "elicitation"); the daemon itself has no terminal.
  it('relays the question of a task that needs the user to the CLI that follows it', async () => {
    const d = await daemonSandbox(config(generation), { GH_TOKEN: FAKE_TOKEN });
    const followed = await d.via(['fs', 'must_task', '--ms', '100', '--mode', 'ask'], { answers: ['Oslo', 'y'] });
    expect(followed.code).toBe(0);
    expect(followed.stdout).toBe('report for Oslo ready after 100ms\n');
    expect(followed.asked).toEqual(['1/1 Region (region) - text, required: ', 'Send these answers to fs? [y]es / [n]o (decline) / [c]ancel: ']);
    expect(followed.stderr).toContain('? fs asks for your input (1 field;');
  });

  it('shows a waiting task without asking, then asks at the terminal that waits for it with `via tasks`', async () => {
    const d = await daemonSandbox(config(generation), { GH_TOKEN: FAKE_TOKEN });
    const detached = await d.via(['fs', '--detach', 'must_task', '--ms', '100', '--mode', 'ask'], { answers: ['never asked'] });
    expect(detached.code).toBe(0);
    expect(detached.asked).toEqual([]);

    const status = await d.via(['tasks', 'fs', 'job/1', '--status'], { answers: ['never asked'] });
    expect(status.asked).toEqual([]);
    expect(status.stdout).toMatch(/^task: fs\/job\/1\nstatus: input_required\n/);
    expect(status.stderr).toMatch(/next: via tasks fs job\/1\n$/);

    const waited = await d.via(['tasks', 'fs', 'job/1'], { answers: ['Oslo', 'y'] });
    expect(waited.code).toBe(0);
    expect(waited.stdout).toBe('report for Oslo ready after 100ms\n');
    expect(waited.asked).toEqual(['1/1 Region (region) - text, required: ', 'Send these answers to fs? [y]es / [n]o (decline) / [c]ancel: ']);
  });

  it('declines the question of a waiting task where there is no terminal: exit code 5, the task has its answer', async () => {
    const d = await daemonSandbox(config(generation), { GH_TOKEN: FAKE_TOKEN });
    await d.via(['fs', '--detach', 'must_task', '--ms', '100', '--mode', 'ask']);
    const r = await d.via(['tasks', 'fs', 'job/1']);
    expect(r.code).toBe(5);
    expect(r.stderr).toBe(
      [
        'error: fs asked for user input ("Which region?") and no terminal was available to answer',
        'the server then said: no region (decline)',
        'next: ask the user to run this in a terminal',
        '',
      ].join('\n'),
    );
  });
});
