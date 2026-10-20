// The reported failure: with a one-character credential, daemon calls died with "blockPieces is not a
// function or its return value is not iterable", because the daemon rewrote the content blocks' `type`
// and the keys. Redaction must keep the result's structure whatever the credential is.
import { describe, expect, it } from 'vitest';
import { ghConfig, startFixtureServer, useCleanup } from '../cli/helpers';
import { daemonSandbox } from '../helpers/daemon';

const SECRETS = ['x', 'text', 'type', 'content'];
const parse = (text: string): any => JSON.parse(text) as unknown;

async function setup(secret: string) {
  const srv = await startFixtureServer({ token: secret, features: ['resources', 'prompts'] });
  useCleanup(() => srv.close());
  const d = await daemonSandbox(ghConfig(srv.url), { GH_TOKEN: secret });
  return { srv, d };
}

describe.each(SECRETS)('GH_TOKEN=%s, through the daemon', (secret) => {
  it('tool calls succeed in every format and keep their structure', async () => {
    const { d } = await setup(secret);
    const whoami = await d.via(['gh', 'whoami']);
    expect(whoami.code, whoami.stderr).toBe(0);
    expect(whoami.stderr).not.toContain('blockPieces');
    expect(whoami.stdout).toContain('***');
    expect(whoami.stdout).not.toContain(secret);

    const json = await d.via(['gh', 'issue:list', '--owner', 'acme', '--repo', 'api', '-o', 'json']);
    expect(json.code, json.stderr).toBe(0);
    expect(Object.keys(parse(json.stdout).items[0])).toEqual(['number', 'title', 'state']);

    const raw = await d.via(['gh', 'whoami', '-o', 'raw']);
    expect(raw.code).toBe(0);
    expect(raw.stdout).not.toContain(secret);

    const echoed = await d.via(['gh', 'echo-text', '--message', `m ${secret} m`, '-o', 'json']);
    expect(parse(echoed.stdout)).toBe(`echo: m ${secret} m`.split(secret).join('***'));
  });

  it('errors keep their envelope; the dry run and batch keep their JSON', async () => {
    const { d } = await setup(secret);
    const broken = await d.via(['gh', 'broken-tool', '-o', 'json']);
    expect(broken.code).toBe(1);
    expect(parse(broken.stderr).error.next).toBe('via gh broken-tool -h');

    const bad = await d.via(['gh', 'issue:list', '--owner', 'acme', '--state', 'opened', '-o', 'json']);
    expect(bad.code).toBe(2);
    expect(parse(bad.stderr).error.details.map((x: { rule: string }) => x.rule)).toEqual(['required', 'enum']);

    const dry = await d.via(['gh', 'echo-text', '--message', `m ${secret} m`, '--dry-run', '-o', 'json']);
    expect(dry.code).toBe(0);
    const dryValue = parse(dry.stdout);
    expect(dryValue).toMatchObject({ dryRun: true, tool: 'gh echo-text', server: 'gh' });
    // The daemon holds the credential, so the argument is redacted there, as a value.
    expect(dryValue.args.message).toBe(`m ${secret} m`.split(secret).join('***'));

    const lines = [{ tool: 'gh/issue:list', args: { owner: 'acme', repo: 'api' } }, { tool: 'gh/echo-text', args: { message: `hi ${secret}` } }];
    const batch = await d.via(['batch', '-o', 'json'], { stdin: `${lines.map((l) => JSON.stringify(l)).join('\n')}\n` });
    expect(batch.code, batch.stderr).toBe(0);
    const records = batch.stdout.split('\n').filter(Boolean).map((l) => parse(l));
    expect(records.map((r) => [r.line, r.tool, r.ok])).toEqual([[1, 'gh/issue:list', true], [2, 'gh/echo-text', true]]);
    expect(records[1].result).toBe(`echo: hi ${secret}`.split(secret).join('***'));
  });

  it('resources, read and prompts keep the protocol fields', async () => {
    const { d } = await setup(secret);
    const resources = await d.via(['resources', 'gh', '-o', 'json']);
    expect(resources.code, resources.stderr).toBe(0);
    expect(Object.keys(parse(resources.stdout).resources[0])).toEqual(['uri', 'name', 'description', 'mimeType']);
    expect(parse(resources.stdout).resources[0].mimeType).toBe('text/plain');

    const read = await d.via(['read', 'gh', 'file:///project/credentials.txt']);
    expect(read.code, read.stderr).toBe(0);
    expect(read.stdout).toContain('***');
    expect(read.stdout).not.toContain(secret);

    const prompt = await d.via(['prompts', 'gh', 'summarize', '-o', 'json']);
    expect(prompt.code, prompt.stderr).toBe(0);
    expect(parse(prompt.stdout).messages.map((m: { role: string }) => m.role)).toEqual(['user', 'user', 'assistant']);
  });
});
