import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_STDIO_SERVER, FAKE_TOKEN, ghConfig, makeSandbox, normalize, startFixtureServer, useCleanup } from './helpers';


async function setup(extraConfig = '', env?: Record<string, string>) {
  const srv = await startFixtureServer({ token: FAKE_TOKEN });
  useCleanup(() => srv.close());
  const sb = makeSandbox(env);
  sb.userConfig(ghConfig(srv.url, extraConfig));
  return { srv, sb };
}

const READ = ['gh', 'issue:read', '--owner', 'acme', '--repo', 'api', '--issue-number', '3', '--method', 'get'];

describe('calling a tool', () => {
  it('writes data to stdout and the meta line to stderr', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(READ);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('number: 3\ntitle: Support OAuth DCR\nstate: open\n');
    expect(normalize(r.stderr)).toBe('· gh issue:read · <t> · 47 bytes\n');
    expect(srv.state.calls).toEqual([{ name: 'issue_read', args: { owner: 'acme', repo: 'api', issue_number: 3, method: 'get' } }]);
  });

  it('accepts the raw name and prints the canonical form', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'Issue_Write', '--owner', 'a', '--repo', 'b', '--title', 't']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('created: t\n');
    expect(normalize(r.stderr)).toContain('· gh issue:write · <t> ·');
  });

  it('accepts a unique resource prefix and a case-insensitive verb', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'ISS:Write', '--owner', 'a', '--repo', 'b', '--title', 't']);
    expect(r.code).toBe(0);
    expect(normalize(r.stderr)).toContain('· gh issue:write ·');
  });

  it('calls a leaf tool by canonical or raw name', async () => {
    const { sb } = await setup();
    const a = await sb.via(['gh', 'request-copilot-review']);
    const b = await sb.via(['gh', 'request_copilot_review']);
    expect(a.stdout).toBe('requested\n');
    expect(b.stdout).toBe('requested\n');
    expect(normalize(b.stderr)).toContain('· gh request-copilot-review ·');
  });

  it('passes a lone required string as a positional argument', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'code:search', 'rust mcp']);
    expect(r.stdout).toBe('results for rust mcp\n');
  });

  it('recognizes global options anywhere, but leaves --p.<name> to the tool', async () => {
    const { srv, sb } = await setup();
    const before = await sb.via(['-o', 'json', ...READ]);
    const after = await sb.via([...READ, '-o', 'json']);
    expect(JSON.parse(before.stdout)).toEqual({ number: 3, title: 'Support OAuth DCR', state: 'open' });
    expect(after.stdout).toBe(before.stdout);
    srv.state.calls.length = 0;
    const p = await sb.via(['gh', 'echo-text', '--p.message', 'hi', '--full']);
    expect(p.code).toBe(0);
    expect(srv.state.calls).toEqual([{ name: 'echo_text', args: { message: 'hi' } }]);
  });

  it('reads --args from stdin and files relative to the working directory', async () => {
    const { srv, sb } = await setup();
    const viaStdin = await sb.via(['call', 'gh/echo-text', '--args', '-'], { stdin: '{"message":"from stdin"}' });
    expect(viaStdin.stdout).toBe('echo: from stdin\n');
    sb.write('project/args.json', '{"message":"from file"}');
    const viaFile = await sb.via(['call', 'gh/echo_text', '--args', '@args.json']);
    expect(viaFile.stdout).toBe('echo: from file\n');
    expect(srv.state.calls.map((c) => c.args.message)).toEqual(['from stdin', 'from file']);
  });

  it('supports -o raw', async () => {
    const { sb } = await setup();
    const r = await sb.via(['-o', 'raw', ...READ]);
    expect(r.stdout).toBe('{"number":3,"title":"Support OAuth DCR","state":"open"}\n');
  });

  it('reports progress on stderr', async () => {
    const sb = makeSandbox();
    sb.userConfig(`sources: false\nservers:\n  job:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(CLI_STDIO_SERVER)}]\n`);
    const r = await sb.via(['job', 'run_job']);
    expect(r.stdout).toBe('job done\n');
    expect(r.stderr).toContain('progress: 1/2 halfway\n');
  });

  it('warns on stderr when structured output does not match outputSchema, and still succeeds', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'stats_get']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('count: many\n');
    expect(r.stderr).toMatch(/^warning: .*outputSchema.*\n· gh stat:get/);
  });

  it('marks calls made with --no-validate as unvalidated', async () => {
    const { srv, sb } = await setup();
    const checked = await sb.via(['gh', 'issue:list', '--owner', 'a']);
    expect(checked.code).toBe(2);
    expect(srv.state.calls).toHaveLength(0);
    const skipped = await sb.via(['gh', 'issue:list', '--owner', 'a', '--no-validate']);
    expect(skipped.code).toBe(0);
    expect(normalize(skipped.stderr)).toMatch(/· gh issue:list · <t> · 178 bytes · unvalidated\n$/);
  });

  it('applies --timeout and reports a timeout with exit 6', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'sleepy', '--ms', '2000', '--timeout', '0.2']);
    expect(r.code).toBe(6);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('error: gh did not answer within 0.2s\nnext: rerun with a larger --timeout\n');
  });

  it('rejects a malformed --timeout or -o with exit 2', async () => {
    const { sb } = await setup();
    expect((await sb.via(['gh', '--timeout', 'soon'])).code).toBe(2);
    expect((await sb.via(['gh', '-o', 'yaml'])).stderr).toContain('-o must be text, json or raw');
    expect((await sb.via(['gh', '-o'])).code).toBe(2);
  });
});

describe('exit codes and errors', () => {
  it('exit 1 for an isError result, with a next: pointing at -h', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'broken_tool']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('error: boom: the upstream failed\nnext: via gh broken-tool -h\n');
  });

  it('adds the "schema and server disagree" note when the server rejects arguments the schema accepted', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'picky_tool', '--n', '3']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^error: Invalid arguments: n must be even\nnote: .*schema and the server disagree.*\nnext: via gh picky-tool -h\n$/);
  });

  it('exit 2 for argument errors: usage on stderr, nothing on stdout, no call', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['gh', 'issue:list', '--owner', 'acme']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('error: --repo is required\nusage: via gh issue:list --owner <str> --repo <str> [--state open|closed] [--per-page <num>]\n');
    expect(srv.state.calls).toHaveLength(0);
  });

  it('prints several argument problems one per line, aligned', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'issue:list', '--state', 'opened']);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(
      [
        'error: 3 invalid arguments',
        '  --owner   required',
        '  --repo    required',
        '  --state   must be one of: open, closed (got "opened"; did you mean "open"?)',
        'usage: via gh issue:list --owner <str> --repo <str> [--state open|closed] [--per-page <num>]',
        'next: via gh issue:list -h',
        '',
      ].join('\n'),
    );
  });

  it('-o json: argument errors are structured JSON on stderr', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'issue:list', '--owner', 'acme', '-o', 'json']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    const error = (JSON.parse(r.stderr) as { error: { code: number; message: string; details: unknown[] } }).error;
    expect(error.code).toBe(2);
    expect(error.details.length).toBeGreaterThan(0);
  });

  it('-o json: other errors use the same envelope', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'nope', '-o', 'json']);
    expect(r.code).toBe(3);
    expect((JSON.parse(r.stderr) as { error: { code: number } }).error.code).toBe(3);
    const timeout = await sb.via(['gh', 'sleepy', '--ms', '2000', '--timeout', '0.2', '-o', 'json']);
    expect(JSON.parse(timeout.stderr)).toEqual({ error: { code: 6, message: 'gh did not answer within 0.2s', next: 'rerun with a larger --timeout' } });
  });

  it('exit 3 with did-you-mean for an unknown provider, resource or tool, and no call', async () => {
    const { srv, sb } = await setup();
    const provider = await sb.via(['gj', 'issue']);
    expect(provider.code).toBe(3);
    expect(provider.stderr).toBe('error: no such provider: gj\ndid you mean: gh\nnext: via gh -h\n');
    const tool = await sb.via(['gh', 'issue:rea']);
    expect(tool.code).toBe(3);
    expect(tool.stderr).toContain('did you mean: gh issue:read');
    const nothing = await sb.via(['gh', 'zzzzzz']);
    expect(nothing.code).toBe(3);
    expect(nothing.stderr).toContain('next: via find gh zzzzzz');
    expect(srv.state.calls).toHaveLength(0);
  });

  it('suggests built-in subcommands for a mistyped command', async () => {
    const { sb } = await setup();
    const r = await sb.via(['sevrers']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('did you mean: servers');
  });

  it('exit 3 and the candidates when a prefix is ambiguous', async () => {
    const { srv, sb } = await setup();
    sb.userConfig(`sources: false\nservers:\n  alpha:\n    url: ${srv.url}\n    auth: { bearer: "env:GH_TOKEN" }\n  alpine:\n    url: ${srv.url}\n    auth: { bearer: "env:GH_TOKEN" }\n`);
    const r = await sb.via(['al', 'issue']);
    expect(r.code).toBe(3);
    expect(r.stderr).toBe('error: ambiguous provider: al\ncandidates: alpha · alpine\nnext: via alpha -h\n');
    expect(srv.state.listCalls).toBe(0);
  });

  it('exit 3 for an ambiguous resource prefix', async () => {
    const { srv, sb } = await setup();
    srv.state.tools = [
      { name: 'pull_request_read', description: 'Read', inputSchema: { type: 'object', properties: {} } },
      { name: 'project_read', description: 'Read', inputSchema: { type: 'object', properties: {} } },
    ];
    const r = await sb.via(['gh', 'p:read']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('candidates: gh project · gh pull-request');
    expect(srv.state.calls).toHaveLength(0);
  });

  it('a leaf tool whose raw name is a resource name keeps it; the resource yields its tools as leaves', async () => {
    const { srv, sb } = await setup();
    srv.state.tools = [
      { name: 'issue_read', description: 'Read', inputSchema: { type: 'object', properties: {} } },
      { name: 'issue', description: 'A tool named like the resource', inputSchema: { type: 'object', properties: {} } },
    ];
    const view = await sb.via(['gh']);
    expect(view.stdout).toMatch(/^tools: issue-read · issue$/m);
    const help = await sb.via(['gh', 'issue', '-h']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('A tool named like the resource');
    expect(srv.state.calls).toHaveLength(0);
  });

  it('exit 4 when a credential is missing, without naming any value', async () => {
    const { srv, sb } = await setup('', {});
    const r = await sb.via(['gh', 'whoami']);
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/^error: environment variable GH_TOKEN is not set/);
    expect(srv.state.listCalls).toBe(0);
  });

  it('exit 4 when the server rejects the credentials; the wrong token is not echoed', async () => {
    const wrong = 'wrong-token-value-for-tests';
    const { sb } = await setup('', { GH_TOKEN: wrong });
    const r = await sb.via(['gh']);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('rejected the credentials (HTTP 401)');
    expect(r.stderr).toContain('next: via auth login gh');
    expect(r.stdout + r.stderr).not.toContain(wrong);
  });

  it('exit 6 when the server is unreachable', async () => {
    const { sb } = await setup();
    sb.userConfig('sources: false\nservers:\n  down:\n    url: http://127.0.0.1:1/mcp\n');
    const r = await sb.via(['down']);
    expect(r.code).toBe(6);
    expect(r.stderr).toMatch(/^error: cannot start down: cannot reach http:\/\/127\.0\.0\.1:1/);
  });
});

describe('deny and confirmation', () => {
  const FILE = ['gh', 'file:delete', '--owner', 'a', '--repo', 'b', '--path', 'x'];

  it('destructive tools need --yes (exit 5, nothing sent)', async () => {
    const { srv, sb } = await setup();
    const refused = await sb.via(FILE);
    expect(refused.code).toBe(5);
    expect(refused.stderr).toBe('error: gh file:delete is destructive and was not run\nnext: rerun with --yes to confirm\n');
    expect(srv.state.calls).toHaveLength(0);
    const confirmed = await sb.via([...FILE, '--yes']);
    expect(confirmed.code).toBe(0);
    expect(confirmed.stdout).toBe('deleted x\n');
  });

  it('--no-validate does not bypass --yes', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['gh', 'file:delete', '--no-validate']);
    expect(r.code).toBe(5);
    expect(srv.state.calls).toHaveLength(0);
  });

  it('confirm: never turns the check off for that server', async () => {
    const { sb } = await setup('    confirm: never\n');
    const r = await sb.via(FILE);
    expect(r.code).toBe(0);
  });

  it('deny hides a tool from every view and refuses direct calls with exit 5', async () => {
    const { srv, sb } = await setup();
    sb.userConfig(`${ghConfig(srv.url)}deny: ["^gh/file:delete$"]\n`);
    expect((await sb.via(['gh'])).stdout).not.toContain('file');
    expect((await sb.via(['find', 'delete'])).stdout).not.toContain('file:delete');
    for (const argv of [[...FILE, '--yes'], ['gh', 'delete_file', '--yes'], ['call', 'gh/file:delete', '--yes']]) {
      const r = await sb.via(argv);
      expect(r.code, argv.join(' ')).toBe(5);
      expect(r.stderr).toContain('is denied by the deny rule');
    }
    expect(srv.state.calls).toHaveLength(0);
  });

  it('an invalid deny regex stops everything (fail closed)', async () => {
    const { srv, sb } = await setup();
    sb.userConfig(`${ghConfig(srv.url)}deny: ["(unclosed"]\n`);
    for (const argv of [[], ['gh'], ['find', 'x'], ['gh', 'whoami']]) {
      const r = await sb.via(argv);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/^error: invalid configuration: .*invalid regular expression/);
      expect(r.stderr).toContain('next: via doctor');
    }
    expect(srv.state.listCalls).toBe(0);
  });
});

describe('--dry-run', () => {
  it('prints the canonical form, server and final arguments, and sends nothing', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['gh', 'issue_write', '--owner', 'a', '--repo', 'b', '--title', 'T', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(normalize(r.stdout)).toMatchInlineSnapshot(`
      "dry run: nothing was sent
      tool: gh issue:write
      raw name: issue_write
      server: gh (http http://127.0.0.1:<port>)
      args:
        {
          "owner": "a",
          "repo": "b",
          "title": "T"
        }
      "
    `);
    expect(srv.state.calls).toHaveLength(0);
  });

  it('is valid JSON with -o json', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'issue:write', '--owner', 'a', '--repo', 'b', '--title', 'T', '--dry-run', '-o', 'json']);
    expect(JSON.parse(r.stdout)).toMatchObject({ dryRun: true, tool: 'gh issue:write', rawName: 'issue_write', server: 'gh', args: { title: 'T' } });
  });

  it('works for destructive tools without --yes and says so; deny still applies', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['gh', 'file:delete', '--owner', 'a', '--repo', 'b', '--path', 'x', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('requires: --yes (destructive tool)');
    expect(srv.state.calls).toHaveLength(0);
    sb.userConfig(`${ghConfig(srv.url)}deny: ["^gh/file:delete$"]\n`);
    expect((await sb.via(['gh', 'file:delete', '--dry-run'])).code).toBe(5);
  });

  it('still validates, so a dry run shows only calls that would pass', async () => {
    const { sb } = await setup();
    expect((await sb.via(['gh', 'issue:write', '--dry-run'])).code).toBe(2);
  });

  it('redacts credentials that appear in the arguments', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'echo-text', '--message', `token=${FAKE_TOKEN}`, '--dry-run']);
    expect(r.stdout).toContain('token=***');
    expect(r.stdout + r.stderr).not.toContain(FAKE_TOKEN);
  });
});

describe('credentials never reach the output', () => {
  it('redacts the resolved token in text, json and raw output, and in argument errors', async () => {
    const { sb } = await setup();
    for (const format of ['text', 'json', 'raw']) {
      const r = await sb.via(['gh', 'whoami', '-o', format]);
      expect(r.code).toBe(0);
      expect(r.stdout, format).toContain('Bearer ***');
      expect(r.stdout + r.stderr, format).not.toContain(FAKE_TOKEN);
    }
    const bad = await sb.via(['gh', 'issue:list', '--owner', FAKE_TOKEN, '--state', FAKE_TOKEN]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('***');
    expect(bad.stdout + bad.stderr).not.toContain(FAKE_TOKEN);
  });

  it('writes no credential to the cache directory', async () => {
    const { sb } = await setup();
    await sb.via(['gh', 'whoami']);
    await sb.via(['gh', 'list_pull_requests', '--owner', 'a', '--repo', 'b']);
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
    const files = walk(sb.cacheDir);
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      expect(file).not.toContain(FAKE_TOKEN);
      expect(readFileSync(file, 'utf8')).not.toContain(FAKE_TOKEN);
    }
  });
});

describe('cursors', () => {
  it('truncates a long result, and `via more` continues it', async () => {
    const { sb } = await setup();
    const first = await sb.via(['gh', 'list_pull_requests', '--owner', 'a', '--repo', 'b']);
    expect(first.code).toBe(0);
    expect(first.stdout.length).toBeLessThanOrEqual(8192);
    const cursor = /next: via more ([0-9a-f]+)/.exec(first.stderr)?.[1];
    expect(cursor).toBeDefined();
    const second = await sb.via(['more', cursor!]);
    expect(second.code).toBe(0);
    expect(second.stdout.split('\n')[0]).toBe('number  title                    state');
    expect(second.stderr).toMatch(/^· gh pull-request:list · /);
    const lastShown = Number(/^(\d+)\s/m.exec(first.stdout.split('\n').slice(-2)[0] ?? '')?.[1]);
    const firstOfSecond = Number(/^(\d+)\s/.exec(second.stdout.split('\n')[1] ?? '')?.[1]);
    expect(firstOfSecond).toBe(lastShown + 1);
  });

  it('--full shows everything and makes no cursor', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'list_pull_requests', '--owner', 'a', '--repo', 'b', '--full']);
    expect(r.stdout.trimEnd().split('\n')).toHaveLength(301);
    expect(r.stderr).not.toContain('via more');
  });

  it('exit 3 for an unknown cursor, with no config needed', async () => {
    const sb = makeSandbox();
    const r = await sb.via(['more', 'ffff']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('next: rerun the original command');
    expect((await sb.via(['more'])).code).toBe(2);
  });

  it('cursor files live in a private cache directory', async () => {
    const { sb } = await setup();
    await sb.via(['gh', 'list_pull_requests', '--owner', 'a', '--repo', 'b']);
    if (process.platform !== 'win32') {
      expect(statSync(join(sb.cacheDir, 'cursors')).mode & 0o777).toBe(0o700);
      expect(statSync(join(sb.cacheDir, 'catalog')).mode & 0o777).toBe(0o700);
    } else {
      expect(statSync(join(sb.cacheDir, 'cursors')).isDirectory()).toBe(true);
    }
  });
});

// Reported against Anysearch: a leaf `search` next to `batch_search` (which splits into
// `search:batch`) could not be called at all, and its read-only search tools, also marked
// destructive, asked for --yes.
describe('a server shaped like Anysearch', () => {
  const ANYSEARCH = [
    { name: 'search', description: 'Search the web', annotations: { readOnlyHint: true, destructiveHint: true }, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'batch_search', description: 'Several searches at once', annotations: { readOnlyHint: true, destructiveHint: true }, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  ];

  it('calls the leaf by its name, by the single-string form and through via call', async () => {
    const { srv, sb } = await setup();
    srv.state.tools = ANYSEARCH;
    const view = await sb.via(['gh']);
    expect(view.stdout).toMatch(/^tools: search · batch-search$/m);
    for (const argv of [['gh', 'search', 'cats'], ['call', 'gh/search', '--args', '{"query":"cats"}']]) {
      const r = await sb.via(argv);
      expect(r, argv.join(' ')).toMatchObject({ code: 0, stdout: 'search: cats\n' });
    }
    const batch = await sb.via(['gh', 'batch-search', '--query', 'dogs']);
    expect(batch).toMatchObject({ code: 0, stdout: 'batch_search: dogs\n' });
    expect(srv.state.calls.map((c) => c.name)).toEqual(['search', 'search', 'batch_search']);
  });

  it('treats a tool marked both read-only and destructive as read-only: no --yes, help says read-only', async () => {
    const { srv, sb } = await setup();
    srv.state.tools = ANYSEARCH;
    const help = await sb.via(['gh', 'search', '-h']);
    expect(help.stdout).toContain('read-only');
    expect(help.stdout).not.toContain('destructive');
    const r = await sb.via(['gh', 'search', 'cats']);
    expect(r.code).toBe(0);
  });
});
