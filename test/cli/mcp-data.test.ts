// `via resources`, `via read`, `via prompts` and roots, in-process (VIA_NO_DAEMON=1 in the test
// environment); the daemon path is covered in test/daemon/mcp-data.test.ts.
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLI_STDIO_SERVER, FAKE_TOKEN, ghConfig, makeSandbox, normalize, startFixtureServer, useCleanup } from './helpers';

async function setup(features: Array<'resources' | 'prompts'> = ['resources', 'prompts']) {
  const srv = await startFixtureServer({ token: FAKE_TOKEN, features });
  useCleanup(() => srv.close());
  const sb = makeSandbox();
  sb.userConfig(ghConfig(srv.url));
  return { srv, sb };
}

describe('via resources', () => {
  it('lists resources and templates, following the pages of the list', async () => {
    const { sb } = await setup();
    const r = await sb.via(['resources', 'gh']);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/^· resources gh · \d+ms · \d+ bytes\n$/);
    await expect(r.stdout).toMatchFileSnapshot('./__snapshots__/resources-list.txt');
  });

  it('prints structured JSON with -o json', async () => {
    const { sb } = await setup();
    const r = await sb.via(['resources', 'gh', '-o', 'json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { resources: Array<{ uri: string }>; templates: Array<{ uriTemplate: string }> };
    expect(parsed.resources.map((x) => x.uri)).toHaveLength(6);
    expect(parsed.templates[0]!.uriTemplate).toBe('file:///project/logs/{date}.log');
  });

  it('accepts a provider prefix and notes the canonical spelling', async () => {
    const { sb } = await setup();
    const r = await sb.via(['RESOURCES', 'g']);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('· resources gh\n');
  });

  it('refuses a server that did not declare resources, without sending a request', async () => {
    const { srv, sb } = await setup(['prompts']);
    const r = await sb.via(['resources', 'gh']);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('error: gh does not offer MCP resources\nnext: via gh\n');
    expect(srv.state.reads).toEqual([]);
  });

  it('reports a usage error without a provider, with one more word, and for an unknown option', async () => {
    const { sb } = await setup();
    expect((await sb.via(['resources'])).stderr).toBe('error: usage: via resources <provider>\nnext: via resources -h\n');
    expect((await sb.via(['resources', 'gh', 'extra'])).code).toBe(2);
    expect((await sb.via(['resources', 'gh', '--bogus'])).stderr).toContain('unknown option --bogus');
  });

  it('fails for an unknown provider with did you mean', async () => {
    const { sb } = await setup();
    const r = await sb.via(['resources', 'gth']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('no such provider: gth');
  });
});

describe('via read', () => {
  it('prints a text resource and the meta line', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['read', 'gh', 'file:///project/README.md']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('# Project\nHello from the readme.\n');
    expect(normalize(r.stderr)).toBe('· read gh · <t> · 33 bytes\n');
    expect(srv.state.reads).toEqual(['file:///project/README.md']);
  });

  it('renders JSON content as a tool result is rendered; -o raw keeps the text as the server sent it', async () => {
    const { sb } = await setup();
    const text = await sb.via(['read', 'gh', 'file:///project/data.json']);
    expect(text.stdout).toBe('name: via\ntags: a, b\n');
    const raw = await sb.via(['read', 'gh', 'file:///project/data.json', '-o', 'raw']);
    expect(raw.stdout).toBe('{"name":"via","tags":["a","b"],"empty":null}\n');
  });

  it('labels the contents of a read with their URIs in JSON too', async () => {
    const { sb } = await setup();
    const r = await sb.via(['read', 'gh', 'file:///project/dir', '-o', 'json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as unknown[];
    expect(parsed[0]).toBe('# file:///project/dir/a.txt');
    expect(parsed[1]).toBe('file a');
    expect(parsed[2]).toBe('# file:///project/dir/b.bin');
    expect(parsed[3]).toMatchObject({ type: 'resource', path: expect.stringMatching(/\.bin$/) });
  });

  it('writes a binary resource to the media cache and prints its path', async () => {
    const { sb } = await setup();
    const r = await sb.via(['read', 'gh', 'file:///project/logo.png']);
    expect(r.code).toBe(0);
    const path = r.stdout.trim();
    expect(path.startsWith(sb.cacheDir)).toBe(true);
    expect(path.endsWith('.png')).toBe(true);
    expect(readFileSync(path).subarray(1, 4).toString()).toBe('PNG');
  });

  it('labels each content with its URI when a read returns several', async () => {
    const { sb } = await setup();
    const r = await sb.via(['read', 'gh', 'file:///project/dir']);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines.slice(0, 3)).toEqual(['# file:///project/dir/a.txt', 'file a', '# file:///project/dir/b.bin']);
    expect(existsSync(lines[3]!)).toBe(true);
  });

  it('reads through a template the caller filled in', async () => {
    const { sb } = await setup();
    const r = await sb.via(['read', 'gh', 'file:///project/logs/2026-10-20.log']);
    expect(r.stdout).toBe('started\nstopped\n');
  });

  it('truncates a long resource into a cursor that via more continues', async () => {
    const { sb } = await setup();
    const first = await sb.via(['read', 'gh', 'file:///project/big.txt']);
    expect(first.code).toBe(0);
    expect(first.stdout.split('\n')[0]).toBe('line 1 of the long text');
    const cursor = /next: via more ([0-9a-f]+)/.exec(first.stderr)?.[1];
    expect(cursor).toBeDefined();
    const more = await sb.via(['more', cursor!]);
    expect(more.code).toBe(0);
    expect(more.stdout.split('\n')[0]).toMatch(/^line \d+ of the long text$/);
    const full = await sb.via(['read', 'gh', 'file:///project/big.txt', '--full']);
    expect(full.stdout.trim().split('\n')).toHaveLength(400);
    expect(full.stderr).not.toContain('next:');
  });

  it('replaces a credential in the content with ***', async () => {
    const { sb } = await setup();
    const r = await sb.via(['read', 'gh', 'file:///project/credentials.txt']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('authorization: Bearer ***\n');
    expect(r.combined).not.toContain(FAKE_TOKEN);
  });

  it('exits 3 with the list as next step for an unknown URI', async () => {
    const { sb } = await setup();
    const r = await sb.via(['read', 'gh', 'file:///project/missing.txt']);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('error: no such resource: file:///project/missing.txt (Resource not found: file:///project/missing.txt)\nnext: via resources gh\n');
  });

  it('treats an invalid-params answer for the URI as not found too', async () => {
    const { sb } = await setup();
    const r = await sb.via(['read', 'gh', 'file:///project/odd']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('no such resource: file:///project/odd (Invalid URI)');
  });

  it('prints the error as JSON with -o json', async () => {
    const { sb } = await setup();
    const r = await sb.via(['read', 'gh', 'file:///project/missing.txt', '-o', 'json']);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stderr)).toEqual({ error: { code: 3, message: expect.stringContaining('no such resource'), next: 'via resources gh' } });
  });

  it('refuses a server without resources and checks the arguments', async () => {
    const { sb } = await setup(['prompts']);
    expect((await sb.via(['read', 'gh', 'file:///project/README.md'])).stderr).toBe('error: gh does not offer MCP resources\nnext: via gh\n');
    expect((await sb.via(['read', 'gh'])).stderr).toBe('error: usage: via read <provider> <uri>\nnext: via read -h\n');
  });

  it('does not treat a URI as a tool reference although it contains a colon', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['gh', 'file:///project/README.md']);
    expect(r.code).toBe(3);
    expect(srv.state.reads).toEqual([]);
  });
});

describe('via prompts', () => {
  it('lists prompts with their signature', async () => {
    const { sb } = await setup();
    const r = await sb.via(['prompts', 'gh']);
    expect(r.code).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot('./__snapshots__/prompts-list.txt');
  });

  it('shows the usage of one prompt with -h', async () => {
    const { sb } = await setup();
    const r = await sb.via(['prompts', 'gh', 'review', '-h']);
    expect(r.code).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot('./__snapshots__/prompts-help.txt');
  });

  it('gets a prompt with named arguments', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['prompts', 'gh', 'review', '--code', 'fn main() {}', '--lang', 'Rust']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('[user]\nPlease review this Rust:\nfn main() {}\n');
    expect(normalize(r.stderr)).toMatch(/^· prompts gh review · <t> · \d+ bytes\n$/);
    expect(srv.state.prompts).toEqual([{ name: 'review', args: { code: 'fn main() {}', lang: 'Rust' } }]);
  });

  it('takes a lone required argument positionally, and a lenient prompt name', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['prompts', 'gh', 'Greet-User', 'Ada']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('[user]\nHello, Ada!\n');
    expect(r.stderr).toContain('· prompts gh greet_user ·');
    expect(srv.state.prompts).toEqual([{ name: 'greet_user', args: { name: 'Ada' } }]);
  });

  it('accepts a unique prefix', async () => {
    const { sb } = await setup();
    const r = await sb.via(['prompts', 'gh', 'summ']);
    expect(r.code).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot('./__snapshots__/prompts-get-messages.txt');
  });

  it('prints messages as JSON with -o json, describing instead of inlining binary content', async () => {
    const { sb } = await setup();
    const r = await sb.via(['prompts', 'gh', 'summarize', '-o', 'json']);
    expect(JSON.parse(r.stdout)).toEqual({
      messages: [
        { role: 'user', content: 'Summarize the readme.' },
        { role: 'user', content: { type: 'resource', uri: 'file:///project/README.md', mimeType: 'text/plain', text: '# Project' } },
        { role: 'assistant', content: 'It is a project.' },
      ],
    });
  });

  it('validates the arguments locally before asking the server', async () => {
    const { srv, sb } = await setup();
    const missing = await sb.via(['prompts', 'gh', 'review']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('error: --code is required');
    expect(missing.stderr).toContain('usage: via prompts gh review --code <str> [--lang <str>]');
    const unknown = await sb.via(['prompts', 'gh', 'review', '--code', 'x', '--bogus', 'y']);
    expect(unknown.code).toBe(2);
    expect(srv.state.prompts).toEqual([]);
  });

  it('shows what the server says when it rejects the arguments (exit code 1)', async () => {
    const { sb } = await setup();
    const r = await sb.via(['prompts', 'gh', 'review', '--no-validate']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Missing required argument: code');
  });

  it('suggests names for an unknown prompt', async () => {
    const { sb } = await setup();
    const r = await sb.via(['prompts', 'gh', 'reveiw']);
    expect(r.code).toBe(3);
    expect(r.stderr).toBe('error: no such prompt: reveiw\ndid you mean: prompts gh review\nnext: via prompts gh review -h\n');
    const none = await sb.via(['prompts', 'gh', 'zzzzzz']);
    expect(none.stderr).toBe('error: no such prompt: zzzzzz\nnext: via prompts gh\n');
  });

  it('refuses a server without prompts', async () => {
    const { sb } = await setup(['resources']);
    const r = await sb.via(['prompts', 'gh']);
    expect(r.code).toBe(3);
    expect(r.stderr).toBe('error: gh does not offer MCP prompts\nnext: via gh\n');
  });

  it('points the old `via prompt` at the new command when given a provider', async () => {
    const { sb } = await setup();
    const r = await sb.via(['prompt', 'gh']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('via prompts <provider>');
  });
});

describe('the provider view', () => {
  it('mentions resources and prompts when the server declared them', async () => {
    const { sb } = await setup();
    const first = await sb.via(['gh']);
    // The first view fetched the list, so it knows the capabilities; the second one reads them from the cache.
    const second = await sb.via(['gh']);
    for (const r of [first, second]) {
      expect(r.stdout).toContain('also: via resources gh · via prompts gh\n→ via gh <resource> for signatures\n');
    }
    await expect(second.stdout).toMatchFileSnapshot('./__snapshots__/cli-provider-also.txt');
  });

  it('mentions only what is there, and nothing for a plain tool server', async () => {
    const only = await setup(['prompts']);
    expect((await only.sb.via(['gh'])).stdout).toContain('also: via prompts gh\n');
    const plain = await setup([]);
    expect((await plain.sb.via(['gh'])).stdout).not.toContain('also:');
  });

  it('shows nothing for a cache written before capabilities were recorded', async () => {
    const { sb } = await setup();
    await sb.via(['gh']);
    const { readdirSync, writeFileSync } = await import('node:fs');
    const dir = `${sb.cacheDir}/catalog`;
    for (const name of readdirSync(dir)) {
      const file = `${dir}/${name}`;
      const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      delete data.features;
      writeFileSync(file, JSON.stringify(data));
    }
    expect((await sb.via(['gh'])).stdout).not.toContain('also:');
    expect((await sb.via(['sync', 'gh'])).code).toBe(0);
    expect((await sb.via(['gh'])).stdout).toContain('also: via resources gh');
  });
});

describe('names', () => {
  it('reserves resources, read and prompts as provider names', async () => {
    const sb = makeSandbox();
    sb.userConfig('sources: false\nservers:\n  read:\n    url: http://127.0.0.1:1/mcp\n');
    const r = await sb.via(['servers']);
    expect(r.stdout).toContain('read');
    const root = await sb.via([]);
    expect(root.stdout).toContain('0 providers');
  });

  it('prints the usage of the commands with -h', async () => {
    const sb = makeSandbox();
    expect((await sb.via(['read', '-h'])).stdout).toBe('usage: via read <provider> <uri>\n');
    expect((await sb.via(['resources', '-h'])).stdout).toContain('usage: via resources <provider>');
    expect((await sb.via(['prompts', '-h'])).stdout).toContain('usage: via prompts <provider>');
  });
});

describe('roots', () => {
  const stdioConfig = (roots: string, features = 'roots') =>
    `sources: false\nservers:\n  fs:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(CLI_STDIO_SERVER)}]\n    env: { CLI_FIXTURE_FEATURES: "${features}" }\n${roots}`;

  it('declares no roots capability by default, so a server cannot ask', async () => {
    const sb = makeSandbox();
    sb.userConfig(stdioConfig(''));
    const r = await sb.via(['fs', 'list-roots']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('roots: the client did not declare the capability\n');
  });

  it('treats an empty list like no list', async () => {
    const sb = makeSandbox();
    sb.userConfig(stdioConfig('    roots: []\n'));
    expect((await sb.via(['fs', 'list-roots'])).stdout).toBe('roots: the client did not declare the capability\n');
  });

  it('answers roots/list with the configured roots, resolved against the working directory and home', async () => {
    const sb = makeSandbox();
    sb.userConfig(stdioConfig('    roots: [".", "sub/dir", "~/notes", "/abs/place", "file:///already/a/uri"]\n'));
    const r = await sb.via(['fs', 'list-roots']);
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n')).toEqual([
      'roots (listChanged: false):',
      `${pathToFileURL(sb.project).href} project`,
      `${pathToFileURL(join(sb.project, 'sub', 'dir')).href} dir`,
      `${pathToFileURL(join(sb.home, 'notes')).href} notes`,
      `${pathToFileURL('/abs/place').href} place`,
      'file:///already/a/uri uri',
      '',
    ]);
  });

  it('resolves relative roots against the directory the command runs in', async () => {
    const sb = makeSandbox();
    sb.userConfig(stdioConfig('    roots: ["."]\n'));
    const elsewhere = sb.write('other/.keep', '');
    const dir = dirname(elsewhere);
    const r = await sb.via(['fs', 'list-roots'], { cwd: dir });
    expect(r.stdout).toContain(pathToFileURL(dir).href);
  });

  it('rejects a root that is not a path or file URI', async () => {
    const sb = makeSandbox();
    sb.userConfig(stdioConfig('    roots: ["https://example.com/x", ""]\n'));
    const r = await sb.via(['fs', 'list-roots']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('servers.fs.roots[0]: expected a path or file:// URI');
    expect(r.stderr).toContain('servers.fs.roots[1]: expected non-empty path or file:// URI');
  });

  it('warns when roots are configured for an HTTP server', async () => {
    const sb = makeSandbox();
    sb.userConfig('sources: false\nservers:\n  remote:\n    url: https://example.com/mcp\n    roots: ["."]\n');
    const r = await sb.via(['servers']);
    expect(r.stdout).toContain('servers.remote.roots: local directories are sent to the remote server remote');
  });

  it('needs `via trust` for roots that a project file adds to a server', async () => {
    const sb = makeSandbox();
    sb.userConfig(stdioConfig(''));
    sb.projectConfig('servers:\n  fs:\n    roots: ["~"]\n');
    const widened = await sb.via(['fs', 'list-roots']);
    expect(widened.code).toBe(5);
    expect(widened.stderr).toContain('untrusted project config');
    const trust = await sb.via(['trust', '--dry-run']);
    expect(trust.stdout).toContain('roots: ~');
  });

  it('lets a project file narrow roots without trust', async () => {
    const sb = makeSandbox();
    sb.userConfig(stdioConfig('    roots: ["."]\n'));
    sb.projectConfig('servers:\n  fs:\n    roots: []\n');
    const r = await sb.via(['fs', 'list-roots']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('roots: the client did not declare the capability\n');
  });
});
