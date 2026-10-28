import { describe, expect, it } from 'vitest';
import { formatToolHelp, formatUsage, parseToolArgs, ToolArgsError } from '../../../src/cli/args';
import { fixtureNames, loadTools } from '../../helpers/fixtures';
import { memoryIO } from './helpers';

// Real-shaped schemas (test/fixtures/tools, other): nothing may crash, whatever a server declares.
describe('fixture tool schemas', () => {
  for (const dir of ['tools', 'other']) {
    for (const name of fixtureNames(dir)) {
      it(`${dir}/${name}: help, usage and an empty call behave`, async () => {
        for (const tool of loadTools(dir, name)) {
          const ctx = { provider: name, ref: `${name} ${tool.name}`, rawName: tool.name, readOnly: !!tool.annotations?.readOnlyHint, destructive: !!tool.annotations?.destructiveHint };
          const usage = formatUsage(tool, ctx);
          expect(usage.startsWith(`usage: via ${name} ${tool.name}`), tool.name).toBe(true);
          // `ref` here is the raw name itself, so there is no second spelling to show.
          expect(formatToolHelp(tool, ctx)).not.toContain('alias:');
          const required = tool.inputSchema?.required ?? [];
          try {
            const r = await parseToolArgs([], tool, ctx, { io: memoryIO(), validate: true });
            expect(required, tool.name).toEqual([]);
            expect(r.args).toEqual({});
          } catch (e) {
            expect(e, tool.name).toBeInstanceOf(ToolArgsError);
            expect((e as ToolArgsError).issues.length).toBeGreaterThan(0);
          }
        }
      });
    }
  }

  it('github issue_read: kebab flags, integer conversion and a clean call', async () => {
    const tool = loadTools('tools', 'github').find((t) => t.name === 'issue_read')!;
    const ctx = { provider: 'github', ref: 'github issue:read', rawName: 'issue_read', readOnly: true, destructive: false };
    const argv = ['--owner', 'acme', '--repo', 'api', '--issue-number', '12', '--method', 'get_comments', '--per-page', '5'];
    expect((await parseToolArgs(argv, tool, ctx, { io: memoryIO(), validate: true })).args).toEqual({
      owner: 'acme',
      repo: 'api',
      issue_number: 12,
      method: 'get_comments',
      perPage: 5,
    });
    await expect(parseToolArgs(['--owner', 'acme', '--repo', 'api', '--issue-number', 'twelve', '--method', 'get_comment'], tool, ctx, { io: memoryIO(), validate: true })).rejects.toMatchObject({
      message: '2 invalid arguments',
      issues: [
        { arg: '--method', message: 'must be one of: get, get_comments, get_sub_issues, get_parent, get_labels (got "get_comment"; did you mean "get_comments"?)' },
        { arg: '--issue-number', message: 'must be an integer (got "twelve")' },
      ],
    });
  });

  it('notion create-pages: a bare required array comes from JSON, parent from dot paths', async () => {
    const tool = loadTools('tools', 'notion').find((t) => t.name === 'notion-create-pages')!;
    const ctx = { provider: 'notion', ref: 'notion page:create', rawName: tool.name, readOnly: false, destructive: false };
    const r = await parseToolArgs(['--pages', '["# Notes"]', '--parent.page_id', 'abc'], tool, ctx, { io: memoryIO(), validate: true });
    expect(r.args).toEqual({ pages: ['# Notes'], parent: { page_id: 'abc' } });
  });
});
