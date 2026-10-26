import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN, ghConfig, makeSandbox, startFixtureServer, useCleanup } from './helpers';

// `-o json` on the browse views and `via find` (discovery.md, "浏览视图"; output.md, "输出格式"), the
// call example under each `via find` result, `--brief`, and `via <provider> -h --all`.

async function setup(extraConfig = '') {
  const srv = await startFixtureServer({ token: FAKE_TOKEN });
  useCleanup(() => srv.close());
  const sb = makeSandbox();
  sb.userConfig(ghConfig(srv.url, extraConfig));
  return { srv, sb };
}

type Listed = {
  ref: string;
  provider: string;
  resource: string | null;
  verb: string | null;
  rawName: string;
  signature: { required: string[]; optional: string[] };
  description: string;
  readOnly: boolean;
  destructive: boolean;
  example?: string;
};

describe('via -o json', () => {
  it('lists providers with their tool count and status; the hint goes to stderr', async () => {
    const { srv, sb } = await setup();
    sb.userConfig(
      `sources: false\nservers:\n  github:\n    url: ${srv.url}\n    auth: { bearer: "env:GH_TOKEN" }\n  linear:\n    url: ${srv.url}\n    auth: { bearer: "env:LINEAR_KEY" }\n  slack:\n    url: http://127.0.0.1:1/mcp\n`,
    );
    sb.projectConfig('servers:\n  figma:\n    command: node\n    args: [server.js]\n');
    const r = await sb.via(['-o', 'json']);
    expect(r.code).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot('./__snapshots__/json-root.txt');
    expect(r.stderr).toBe('→ via <provider> to browse · via find <query> to search\n');
    const out = JSON.parse(r.stdout) as { providers: Array<{ provider: string; tools: number; status: string }> };
    expect(out.providers.map((p) => [p.provider, p.status])).toEqual([
      ['figma', 'untrusted'],
      ['github', 'ok'],
      ['linear', 'needs auth'],
      ['slack', 'failed'],
    ]);
    // The same facts as the text view.
    const text = await sb.via([]);
    for (const p of out.providers) expect(text.stdout).toMatch(p.status === 'ok' ? new RegExp(`^${p.provider}\\s+${p.tools} tools$`, 'm') : new RegExp(`^${p.provider}\\s+${p.status}$`, 'm'));
  });

  it('is an empty list, with the note on stderr, when nothing is configured', async () => {
    const sb = makeSandbox();
    const r = await sb.via(['-o', 'json']);
    expect(JSON.parse(r.stdout)).toEqual({ providers: [] });
    expect(r.stderr).toContain('no MCP servers found');
  });

  it('lists the resources and verbs of a provider, the leaf tools and what else the server has', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', '-o', 'json']);
    expect(r.code).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot('./__snapshots__/json-provider.txt');
    const out = JSON.parse(r.stdout) as { provider: string; resources: Array<{ name: string; verbs: string[] }>; tools: string[]; also: Record<string, boolean> };
    expect(out.resources.find((x) => x.name === 'issue')?.verbs).toEqual(['read', 'write', 'list']);
    expect(out.tools).toContain('whoami');
    expect(out.also).toEqual({ resources: false, prompts: false, skills: false });
    expect(r.stderr).toBe('→ via gh <resource> for signatures\n');
  });

  it('lists every tool of a resource with its full signature and hints', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'issue', '-o', 'json']);
    expect(r.code).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot('./__snapshots__/json-resource.txt');
    const out = JSON.parse(r.stdout) as Listed[];
    expect(out.map((t) => t.ref)).toEqual(['gh issue:read', 'gh issue:write', 'gh issue:list']);
    expect(out[0]).toMatchObject({ provider: 'gh', resource: 'issue', verb: 'read', rawName: 'issue_read', readOnly: true, destructive: false });
    expect(out[0]!.signature).toEqual({ required: ['owner', 'repo', 'issue-number', 'method'], optional: [] });
    expect(out[0]).not.toHaveProperty('example');
    expect(r.stderr).toBe('→ via gh issue:<verb> -h for usage\n');
    // The destructive hint.
    const file = JSON.parse((await sb.via(['gh', 'file', '-o', 'json'])).stdout) as Listed[];
    expect(file[0]).toMatchObject({ ref: 'gh file:delete', destructive: true, readOnly: false });
  });

  it('keeps the canonical-form note on stderr when the names were abbreviated', async () => {
    const { sb } = await setup();
    const r = await sb.via(['G', 'ISS', '-o', 'json']);
    expect(r.stderr).toBe('· gh issue\n→ via gh issue:<verb> -h for usage\n');
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse((await sb.via(['gh', 'issue', '-o', 'json'])).stdout));
  });

  it('is the same list on a cold and on a warm prebuilt catalog', async () => {
    const { sb } = await setup();
    const cold = await sb.via(['gh', 'issue', '-o', 'json']);
    const warm = await sb.via(['gh', 'issue', '-o', 'json']);
    expect(warm.stdout).toBe(cold.stdout);
    const findCold = await sb.via(['find', 'issue', '-o', 'json']);
    const findWarm = await sb.via(['find', 'issue', '-o', 'json']);
    expect(findWarm.stdout).toBe(findCold.stdout);
  });

  it('writes no credential value, and redacts server text as content', async () => {
    const { srv, sb } = await setup();
    srv.state.tools = [{ name: 'issue_read', description: `read it with ${FAKE_TOKEN}`, inputSchema: { type: 'object', properties: { owner: { type: 'string', description: FAKE_TOKEN } }, required: ['owner'] } }];
    await sb.via(['sync']);
    for (const args of [[], ['gh'], ['gh', 'issue'], ['find', 'read']]) {
      const r = await sb.via([...args, '-o', 'json']);
      expect(r.code, args.join(' ')).toBe(0);
      expect(r.stdout + r.stderr, args.join(' ')).not.toContain(FAKE_TOKEN);
    }
    const found = JSON.parse((await sb.via(['find', 'read', '-o', 'json'])).stdout) as Listed[];
    expect(found[0]!.description).toBe('read it with ***');
  });

  it('is not available as -o raw: exit 2 with the command to run instead', async () => {
    const { sb } = await setup();
    for (const [args, next] of [
      [[], 'via -o json'],
      [['gh'], 'via gh -o json'],
      [['gh', 'issue'], 'via gh issue -o json'],
      [['find', 'issue'], 'via find issue -o json'],
      [['servers'], 'via servers -o json'],
    ] as const) {
      const r = await sb.via([...args, '-o', 'raw']);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe(`error: -o raw applies to a tool call: a listing has no upstream text to show\nnext: ${next}\n`);
    }
    // A tool call keeps its raw output.
    expect((await sb.via(['gh', 'whoami', '-o', 'raw'])).code).toBe(0);
  });
});

describe('via find: call examples', () => {
  it('puts the example of -h under each result; --brief leaves them out', async () => {
    const { sb } = await setup();
    const r = await sb.via(['find', 'issue']);
    const lines = r.stdout.trimEnd().split('\n');
    const results = lines.filter((l) => !l.startsWith(' '));
    expect(results.length).toBeGreaterThan(1);
    for (const line of lines.filter((l) => l.startsWith(' '))) expect(line).toMatch(/^ {2}example: via (gh|fs) /);
    // Each is what -h shows for that tool.
    for (const ref of ['issue:read', 'issue:write', 'issue:list']) {
      const help = await sb.via(['gh', ref, '-h']);
      const example = help.stdout.split('\n').find((l) => l.startsWith('example: '))!;
      expect(r.stdout).toContain(`  ${example}\n`);
    }
    const brief = await sb.via(['find', 'issue', '--brief']);
    expect(brief.stdout).not.toContain('example:');
    expect(brief.stdout.trimEnd().split('\n')).toEqual(results);
  });

  it('is the same output when the catalog was built by a browse first, by find first, or read warm', async () => {
    const first = await setup();
    const a = await first.sb.via(['find', 'issue', '-n', '3']);
    const second = await setup();
    await second.sb.via(['gh', 'issue']); // a browse builds the catalog without examples
    const b = await second.sb.via(['find', 'issue', '-n', '3']);
    const c = await second.sb.via(['find', 'issue', '-n', '3']);
    expect(b.stdout).toBe(a.stdout);
    expect(c.stdout).toBe(a.stdout);
    expect(a.stdout).toContain('example: via ');
  });

  it('has an example field in -o json unless --brief', async () => {
    const { sb } = await setup();
    const r = await sb.via(['find', 'issue', '-o', 'json']);
    expect(r.code).toBe(0);
    await expect(r.stdout).toMatchFileSnapshot('./__snapshots__/json-find.txt');
    const out = JSON.parse(r.stdout) as Listed[];
    expect(out.map((t) => t.ref)).toContain('gh issue:read');
    const read = out.find((t) => t.ref === 'gh issue:read')!;
    const help = await sb.via(['gh', 'issue:read', '-h']);
    expect(`example: ${read.example}`).toBe(help.stdout.split('\n').find((l) => l.startsWith('example: ')));
    const brief = JSON.parse((await sb.via(['find', 'issue', '--brief', '-o', 'json'])).stdout) as Listed[];
    expect(brief.every((t) => !('example' in t))).toBe(true);
    expect(brief.map((t) => t.ref)).toEqual(out.map((t) => t.ref));
  });

  it('prints [] for no match with the usual note on stderr', async () => {
    const { sb } = await setup();
    const r = await sb.via(['find', 'zzzzzzzz', '-o', 'json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
    expect(r.stderr).toBe('no tools match "zzzzzzzz"\n→ via to list providers\n');
  });
});

describe('via <provider> -h --all', () => {
  it('lists the usage line of every tool after the provider view', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', '-h', '--all']);
    expect(r.code).toBe(0);
    const cut = r.stdout.indexOf('\n\nusage: ');
    expect(cut).toBeGreaterThan(0);
    const head = r.stdout.slice(0, cut);
    const usage = r.stdout.slice(cut + 2);
    expect(head).toContain('from the server (its own text, not via\'s):');
    expect(head).toContain('→ via gh <resource> for signatures');
    const lines = usage.trimEnd().split('\n').filter((l) => l.startsWith('usage: '));
    expect(lines).toContain('usage: via gh issue:read --owner <str> --repo <str> --issue-number <num> --method get|get_comments');
    // The same line as the tool's own -h.
    const help = await sb.via(['gh', 'issue:write', '-h']);
    expect(lines).toContain(help.stdout.split('\n')[0]);
    // Without --all nothing is added.
    expect((await sb.via(['gh', '-h'])).stdout).not.toContain('usage: via gh');
    expect(usage).not.toContain('--owner  '); // no parameter descriptions
  });

  it('is an array of the tool details with -o json', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', '-h', '--all', '-o', 'json']);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as Array<{ tool: string; rawName: string; inputSchema: unknown }>;
    expect(out.length).toBeGreaterThan(5);
    const single = JSON.parse((await sb.via(['gh', 'issue:read', '-h', '-o', 'json'])).stdout) as unknown;
    expect(out.find((t) => t.tool === 'gh issue:read')).toEqual(single);
  });
});
