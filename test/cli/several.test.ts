// Several things in one command (cli.md, "一次看几个"), a tool reference written the way the
// listings print it, and the note of `via find` about a word nothing answers.
import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN, ghConfig, makeSandbox, normalize, startFixtureServer, useCleanup } from './helpers';

async function setup() {
  const srv = await startFixtureServer({ token: FAKE_TOKEN });
  useCleanup(() => srv.close());
  const sb = makeSandbox();
  sb.userConfig(ghConfig(srv.url));
  return { srv, sb };
}

describe('several resources or tools at once', () => {
  it('shows the view of each resource named, a blank line between them', async () => {
    const { srv, sb } = await setup();
    const issue = await sb.via(['gh', 'issue']);
    const pulls = await sb.via(['gh', 'pull-request']);
    const file = await sb.via(['gh', 'file']);
    const both = await sb.via(['gh', 'issue', 'pull-request', 'file']);
    expect(both.code).toBe(0);
    expect(both.stdout).toBe(`${issue.stdout}\n${pulls.stdout}\n${file.stdout}`);
    expect(both.stderr).toBe('');
    expect(srv.state.calls).toHaveLength(0);
  });

  it('keeps `<resource> <verb>` a call, and any other word after a resource an error', async () => {
    const { srv, sb } = await setup();
    // `list` is a verb of issue: a call, as before
    const call = await sb.via(['gh', 'issue', 'list', '--owner', 'a', '--repo', 'b']);
    expect(call.code).toBe(0);
    expect(srv.state.calls.map((c) => c.name)).toEqual(['issue_list']);
    // a word that names nothing
    const bogus = await sb.via(['gh', 'issue', 'bogus']);
    expect(bogus.code).toBe(2);
    expect(bogus.stderr).toContain('error: unexpected argument "bogus"');
    // also in the middle of a list, and a prefix is not a name there
    const second = await sb.via(['gh', 'issue', 'file', 'bogus']);
    expect(second.code).toBe(2);
    expect(second.stderr).toContain('error: unexpected argument "bogus"');
    expect(second.stdout).toBe('');
    expect((await sb.via(['gh', 'issue', 'fil'])).code).toBe(2);
    // without -h a tool is not something to show next to a resource: nothing is called by accident
    const tool = await sb.via(['gh', 'issue', 'whoami']);
    expect(tool.code).toBe(2);
    expect(srv.state.calls).toHaveLength(1);
  });

  it('shows the usage of each tool named with -h, and a resource view among them', async () => {
    const { srv, sb } = await setup();
    const read = await sb.via(['gh', 'issue:read', '-h']);
    const write = await sb.via(['gh', 'issue:write', '-h']);
    const file = await sb.via(['gh', 'file']);
    const who = await sb.via(['gh', 'whoami', '-h']);
    const all = await sb.via(['gh', 'issue:read', 'issue:write', 'file', 'whoami', '-h']);
    expect(all.code).toBe(0);
    expect(all.stdout).toBe([read.stdout, write.stdout, file.stdout, who.stdout].join('\n'));
    // the raw name and the `<resource> <verb>` form name tools too; the same tool twice is shown once
    const spelled = await sb.via(['gh', 'issue', 'read', 'Issue_Write', 'issue:read', '-h']);
    expect(spelled.stdout).toBe(`${read.stdout}\n${write.stdout}`);
    expect(normalize(spelled.stderr)).toBe('· gh issue:read\n· gh issue:write\n');
    // after a resource: resources and tools alike
    const mixed = await sb.via(['gh', 'file', 'issue:read', '-h']);
    expect(mixed.stdout).toBe(`${file.stdout}\n${read.stdout}`);
    expect(srv.state.calls).toHaveLength(0);
  });

  it('with -h, leaves the arguments of a half-written call alone, but not a reference that does not resolve', async () => {
    const { srv, sb } = await setup();
    const read = await sb.via(['gh', 'issue:read', '-h']);
    expect((await sb.via(['gh', 'issue:read', '--owner', 'acme', '--repo', 'api', '-h'])).stdout).toBe(read.stdout);
    // a positional value is no tool name
    const search = await sb.via(['gh', 'code:search', '-h']);
    expect((await sb.via(['gh', 'code:search', 'rust mcp', '-h'])).stdout).toBe(search.stdout);
    expect((await sb.via(['gh', 'code:search', 'iss', '-h'])).stdout).toBe(search.stdout);
    const typo = await sb.via(['gh', 'issue:read', 'issue:wrte', '-h']);
    expect(typo.code).toBe(3);
    expect(typo.stdout).toBe('');
    expect(typo.stderr).toContain('error: no such tool: issue:wrte\ndid you mean: gh issue:write');
    expect(srv.state.calls).toHaveLength(0);
  });

  it('prints one JSON array for several, in the order named; refuses -o raw and a schema snapshot', async () => {
    const { sb } = await setup();
    const out = await sb.via(['gh', 'issue', 'issue:read', '-h', '-o', 'json']);
    const [resource, tool] = JSON.parse(out.stdout) as [Array<{ ref: string }>, { tool: string; inputSchema: unknown }];
    expect(resource.map((t) => t.ref)).toEqual(['gh issue:read', 'gh issue:write', 'gh issue:list']);
    expect(tool).toMatchObject({ tool: 'gh issue:read', rawName: 'issue_read' });
    expect(tool.inputSchema).toBeDefined();
    expect((await sb.via(['gh', 'issue', 'file', '-o', 'raw'])).code).toBe(2);
    const snap = await sb.via(['gh', 'issue:read', 'issue:write', '-h', '--schema-snapshot', 'x.json']);
    expect(snap.code).toBe(2);
    expect(snap.stderr).toContain('--schema-snapshot compares one tool; name one');
  });
});

describe('a tool reference as the listings print it', () => {
  const ARGS = ['--owner', 'acme', '--repo', 'api', '--issue-number', '3', '--method', 'get'];

  it('via call takes "<provider> <tool>" as one word or as two, like <provider>/<tool>', async () => {
    const { srv, sb } = await setup();
    const slash = await sb.via(['call', 'gh/issue:read', ...ARGS]);
    const quoted = await sb.via(['call', 'gh issue:read', ...ARGS]);
    const words = await sb.via(['call', 'gh', 'issue:read', ...ARGS]);
    expect(quoted.stdout).toBe(slash.stdout);
    expect(words.stdout).toBe(slash.stdout);
    expect(srv.state.calls).toHaveLength(3);
    // the raw name after the provider, and a resource is still not a tool
    expect((await sb.via(['call', 'gh issue_read', ...ARGS])).code).toBe(0);
    const resource = await sb.via(['call', 'gh issue']);
    expect(resource.code).toBe(2);
    expect(resource.stderr).toContain('error: gh/issue is a resource, not a tool');
    // what is no reference in either spelling
    for (const bad of [['call', 'issue:read'], ['call', 'gh issue read'], ['call', 'gh/'], ['call']]) {
      const r = await sb.via(bad);
      expect(r.code, bad.join(' ')).toBe(2);
      expect(r.stderr).toContain('expected a tool reference like <provider>/<resource>:<verb> or "<provider> <resource>:<verb>"');
    }
  });

  it('via batch takes it in "tool"', async () => {
    const { srv, sb } = await setup();
    const line = (tool: string): string => JSON.stringify({ tool, args: { owner: 'acme', repo: 'api', issue_number: 1, method: 'get' } });
    const r = await sb.via(['batch'], { stdin: `${line('gh issue:read')}\n${line('gh/issue:read')}\n${line('gh   issue_read')}\n` });
    expect(r.code).toBe(0);
    expect(srv.state.calls.map((c) => c.name)).toEqual(['issue_read', 'issue_read', 'issue_read']);
    expect(normalize(r.stderr)).toContain('· gh issue:read · <t> · 47 bytes · line 1\n');
    const bad = await sb.via(['batch'], { stdin: `${JSON.stringify({ tool: 'gh issue read' })}\n` });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('error: line 1: expected a tool reference like');
  });
});

describe('via find and a word nothing answers', () => {
  it('says which word no tool mentions when the results matched the rest of the query', async () => {
    const { sb } = await setup();
    const r = await sb.via(['find', 'kubernetes issue', '--brief']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('gh issue:read');
    expect(r.stderr).toBe('· no tool mentions "kubernetes": these matched the rest of the query · via <provider> lists every tool of a provider\n');
    const json = await sb.via(['find', 'kubernetes issues', '-o', 'json']);
    expect((JSON.parse(json.stdout) as unknown[]).length).toBeGreaterThan(0);
    expect(json.stderr).toContain('· no tool mentions "kubernetes"');
  });

  it('says nothing when every word found something, for a tool name, and when nothing matched at all', async () => {
    const { sb } = await setup();
    expect((await sb.via(['find', 'read issue'])).stderr).toBe('');
    // a plural, a synonym and the provider's name all count as answered
    expect((await sb.via(['find', 'gh issues'])).stderr).toBe('');
    expect((await sb.via(['find', 'fetch issue'])).stderr).toBe('');
    // a reference typed with a prefix is a hit on the name
    expect((await sb.via(['find', 'issue:re'])).stderr).toBe('');
    const none = await sb.via(['find', 'kubernetes']);
    expect(none.stdout).toContain('no tools match "kubernetes"');
    expect(none.stderr).toBe('');
  });
});
