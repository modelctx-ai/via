// A credential that is one character, or a word the protocol itself uses (`x`, `1`, `text`, `type`),
// must be redacted wherever it is content and must never rewrite structure (output.md, "脱敏";
// security.md). Each case starts a server that wants exactly that value as its bearer token.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLI_STDIO_SERVER, ghConfig, makeSandbox, startFixtureServer, useCleanup } from './helpers';

/** Values that appear in tool output as words, hex digits, JSON syntax or protocol fields. */
const SECRETS = ['x', 'e', 'a', '1', 'true', 'json', 'text', 'type'];

async function setup(secret: string) {
  const srv = await startFixtureServer({ token: secret, features: ['resources', 'prompts'] });
  useCleanup(() => srv.close());
  const sb = makeSandbox({ GH_TOKEN: secret });
  sb.userConfig(ghConfig(srv.url));
  return { srv, sb };
}

/** Every string in a JSON value, keys excluded. */
function stringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringValues(v, out));
  else if (value !== null && typeof value === 'object') Object.values(value).forEach((v) => stringValues(v, out));
  return out;
}

const parse = (text: string): any => JSON.parse(text) as unknown;

describe.each(SECRETS)('GH_TOKEN=%s, in-process', (secret) => {
  it('tool results: -o json stays valid JSON with its keys; content values are redacted', async () => {
    const { sb } = await setup(secret);
    const r = await sb.via(['gh', 'issue:list', '--owner', 'acme', '--repo', 'api', '-o', 'json']);
    expect(r.code).toBe(0);
    const value = parse(r.stdout);
    expect(Object.keys(value)).toEqual(['items']);
    expect(Object.keys(value.items[0])).toEqual(['number', 'title', 'state']);
    for (const s of stringValues(value)) expect(s).not.toContain(secret);
  });

  it('tool results: text and raw output work, and the credential is not in them', async () => {
    const { sb } = await setup(secret);
    for (const format of ['text', 'raw']) {
      const r = await sb.via(['gh', 'whoami', '-o', format]);
      expect(r.code, format).toBe(0);
      expect(r.stdout, format).toContain('***');
      expect(r.stdout, format).not.toContain(secret);
    }
    const table = await sb.via(['gh', 'issue:list', '--owner', 'acme', '--repo', 'api']);
    expect(table.code).toBe(0);
    expect(table.stdout.split('\n')[0]).toBe('items:');
  });

  it('an echoed argument is redacted as content, the surrounding output is not', async () => {
    const { sb } = await setup(secret);
    const r = await sb.via(['gh', 'echo-text', '--message', `a ${secret} b`, '-o', 'json']);
    expect(r.code).toBe(0);
    // "echo: " is the server's own text, so a credential that occurs in it is redacted there as well.
    expect(parse(r.stdout)).toBe(`echo: a ${secret} b`.split(secret).join('***'));
  });

  it('upstream errors: the JSON envelope keeps its fields', async () => {
    const { sb } = await setup(secret);
    const r = await sb.via(['gh', 'broken-tool', '-o', 'json']);
    expect(r.code).toBe(1);
    const error = parse(r.stderr).error;
    expect(Object.keys(error)).toEqual(['code', 'message', 'next']);
    expect(error.code).toBe(1);
    expect(error.next).toBe('via gh broken-tool -h');
  });

  it('argument errors: text labels and usage, and the JSON details, are not rewritten', async () => {
    const { sb } = await setup(secret);
    const text = await sb.via(['gh', 'issue:list', '--owner', 'acme', '--state', 'opened']);
    expect(text.code).toBe(2);
    expect(text.stderr).toContain('error: 2 invalid arguments');
    expect(text.stderr).toContain('usage: via gh issue:list --owner <str> --repo <str> [--state open|closed] [--per-page <num>]');
    expect(text.stderr).toContain('next: via gh issue:list -h');

    const json = await sb.via(['gh', 'issue:list', '--owner', 'acme', '--state', 'opened', '-o', 'json']);
    const error = parse(json.stderr).error;
    expect(error.message).toBe('2 invalid arguments');
    expect(error.details.map((d: { rule: string }) => d.rule)).toEqual(['required', 'enum']);
    expect(error.details[0]).toMatchObject({ arg: '--repo', path: '/repo', rule: 'required' });
  });

  it('--dry-run: valid JSON with its fields; the arguments are redacted as values', async () => {
    const { sb } = await setup(secret);
    const r = await sb.via(['gh', 'echo-text', '--message', `m ${secret} m`, '--dry-run', '-o', 'json']);
    expect(r.code).toBe(0);
    const value = parse(r.stdout);
    expect(value).toMatchObject({ dryRun: true, tool: 'gh echo-text', rawName: 'echo_text', server: 'gh' });
    expect(value.args.message).toBe(`m ${secret} m`.split(secret).join('***'));
    const text = await sb.via(['gh', 'echo-text', '--message', `m ${secret} m`, '--dry-run']);
    expect(text.stdout).toMatch(/^dry run: nothing was sent\ntool: gh echo-text\nraw name: echo_text\nserver: gh \(http /);
  });

  it('progress lines keep their shape', async () => {
    // Progress only travels over stdio; the server's environment holds the credential, so it is resolved.
    const sb = makeSandbox({ GH_TOKEN: secret });
    sb.userConfig(`sources: false\nservers:\n  job:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(CLI_STDIO_SERVER)}]\n    env: { FIXTURE_SECRET: "env:GH_TOKEN" }\n`);
    const r = await sb.via(['job', 'run_job']);
    expect(r.code).toBe(0);
    // The label and the counts are ours; the message is the server's text, redacted like any content.
    expect(r.stderr.split('\n')[0]).toBe(`progress: 1/2 ${'halfway'.split(secret).join('***')}`);
  });

  it('resources, read and prompts: -o json keeps role, mimeType and the other protocol fields', async () => {
    const { sb } = await setup(secret);
    const resources = parse((await sb.via(['resources', 'gh', '-o', 'json'])).stdout);
    expect(resources.resources[0].mimeType).toBe('text/plain');
    expect(Object.keys(resources.resources[0])).toEqual(['uri', 'name', 'description', 'mimeType']);
    const prompt = await sb.via(['prompts', 'gh', 'summarize', '-o', 'json']);
    expect(prompt.code).toBe(0);
    expect(parse(prompt.stdout).messages.map((m: { role: string }) => m.role)).toEqual(['user', 'user', 'assistant']);
    const read = await sb.via(['read', 'gh', 'file:///project/credentials.txt']);
    expect(read.code).toBe(0);
    expect(read.stdout).toContain('***');
    expect(read.stdout).not.toContain(secret);
  });

  it('a saved file keeps its real path in text and JSON output', async () => {
    const { sb } = await setup(secret);
    const text = await sb.via(['read', 'gh', 'file:///project/logo.png']);
    const path = text.stdout.trim();
    expect(existsSync(path)).toBe(true);
    const json = await sb.via(['read', 'gh', 'file:///project/logo.png', '-o', 'json']);
    expect(existsSync(parse(json.stdout).path)).toBe(true);
    expect(parse(json.stdout).type).toBe('resource');
  });

  it('via batch -o json: every record is valid JSON with its fields', async () => {
    const { sb } = await setup(secret);
    const lines = [
      { tool: 'gh/issue:list', args: { owner: 'acme', repo: 'api' } },
      { tool: 'gh/echo-text', args: { message: `hi ${secret}` } },
      { tool: 'gh/broken-tool' },
      { tool: 'gh/nothing-like-it' },
    ];
    const r = await sb.via(['batch', '-o', 'json'], { stdin: `${lines.map((l) => JSON.stringify(l)).join('\n')}\n` });
    expect(r.code).toBe(3);
    const records = r.stdout.split('\n').filter(Boolean).map((l) => parse(l));
    expect(records.map((x) => [x.line, x.ok, x.exitCode])).toEqual([[1, true, 0], [2, true, 0], [3, false, 1], [4, false, 3]]);
    expect(records.slice(0, 3).map((x) => x.tool)).toEqual(['gh/issue:list', 'gh/echo-text', 'gh/broken-tool']);
    expect(Object.keys(records[0].result.items[0])).toEqual(['number', 'title', 'state']);
    expect(records[1].result).toBe(`echo: hi ${secret}`.split(secret).join('***'));
    expect(Object.keys(records[2].error)).toEqual(['code', 'message', 'next']);
    expect(records[2].error.next).toBe('via gh broken-tool -h');
    expect(records[3].error.code).toBe(3);
  });
});
