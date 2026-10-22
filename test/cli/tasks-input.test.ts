// A task that needs the user's input while a call follows it (cli.md "任务"; ADR 0018, ADR 0020), in-process, on whichever
// protocol generation the run is on (helpers/generation.ts). The stdio fixture keeps the task in its own process, which is
// what the old protocol needs: its `tasks/result` request carries the server's `elicitation/create` back to the client. The
// stateless protocol's `inputRequests` / `tasks/update` and the `via tasks` command are in tasks.test.ts (HTTP) and in
// test/daemon/tasks.test.ts (a daemon keeps the task between commands).
import { describe, expect, it } from 'vitest';
import { CLI_STDIO_SERVER, makeSandbox, normalize, type Sandbox } from './helpers';

const config = `sources: false\nservers:\n  ask:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(CLI_STDIO_SERVER)}]\n    env: { CLI_FIXTURE_FEATURES: "tasks,elicit" }\n`;

function sandbox(): Sandbox {
  const sb = makeSandbox();
  sb.userConfig(config);
  return sb;
}

// `must_task` is a task on either generation (the old one asks for it because the tool requires it); `--mode ask` makes
// the job wait for the user's answer to "Which region?" before it finishes.
const CALL = ['ask', 'must_task', '--ms', '100', '--mode', 'ask'];

describe('a call that follows a task into input_required', () => {
  it('asks at a terminal, hands the answer to the server and goes on to the result', async () => {
    const sb = sandbox();
    const r = await sb.via(CALL, { answers: ['Oslo', 'y'] });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('report for Oslo ready after 100ms\n');
    expect(r.asked).toEqual(['1/1 Region (region) - text, required: ', 'Send these answers to ask? [y]es / [n]o (decline) / [c]ancel: ']);
    expect(normalize(r.stderr)).toMatch(/^progress: task ask\/job\/1 working\n\n\? ask asks for your input \(1 field;/);
    expect(r.stderr).toContain('  | Which region?\n');
    expect(r.stderr).toContain('answers for ask:\n  region: Oslo\n');
  });

  it('without a terminal declines, and the failure that follows is exit code 5 with the server’s own words', async () => {
    const sb = sandbox();
    const r = await sb.via(CALL);
    expect(r.code).toBe(5);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(
      [
        'progress: task ask/job/1 working',
        'error: ask asked for user input ("Which region?") and no terminal was available to answer',
        'the server then said: no region (decline)',
        'next: ask the user to run this in a terminal: via ask must-task --ms 100 --mode ask',
        '',
      ].join('\n'),
    );
  });

  it('declines in via batch even where stdin is a terminal', async () => {
    const sb = sandbox();
    const r = await sb.via(['batch'], { answer: 'y', stdin: '{"tool":"ask/must_task","args":{"ms":100,"mode":"ask"}}\n' });
    expect(r.asked).toEqual([]);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain('error: line 1: ask asked for user input ("Which region?") and no terminal was available to answer');
  });

  it('a person who cancels is not a refusal: the server decides, the exit code is the failed task’s', async () => {
    const sb = sandbox();
    const r = await sb.via(CALL, { answers: ['Oslo', 'c'] });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no region (cancel)');
    expect(r.stderr).not.toContain('no terminal');
  });
});

describe('--detach never asks', () => {
  it('returns the task as it is: no prompt, no answer sent', async () => {
    const sb = sandbox();
    const r = await sb.via(['ask', '--detach', 'must_task', '--ms', '100', '--mode', 'ask'], { answers: ['Oslo', 'y'] });
    expect(r.code).toBe(0);
    expect(r.asked).toEqual([]);
    expect(r.stdout).toMatch(/^task: ask\/job\/1\nstatus: (working|input_required)\n/);
    expect(r.stderr).toContain('next: via tasks ask job/1\n');
  });
});
