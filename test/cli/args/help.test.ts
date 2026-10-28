import { describe, expect, it } from 'vitest';
import { formatToolHelp, formatUsage } from '../../../src/cli/args';
import { CTX, ISSUE_LIST, ISSUE_READ, NOTION_PARENT, makeTool } from './helpers';

const github = { provider: 'github', ref: 'github issue:read', rawName: 'issue_read', readOnly: true, destructive: false };

describe('formatToolHelp (arguments.md, "帮助")', () => {
  it('matches the issue:read example', () => {
    const tool = makeTool(ISSUE_READ, { name: 'issue_read', description: 'Get issue details' });
    expect(formatToolHelp(tool, github)).toBe(
      [
        'usage: via github issue:read --owner <str> --repo <str> --issue-number <num>',
        '         --method get|get_comments|get_sub_issues|get_parent|get_labels',
        '         [--page <num>] [--per-page <num>]',
        '',
        'Get issue details',
        '  --owner          <str>',
        '  --repo           <str>',
        '  --issue-number   <num>',
        '  --method         get: Get issue details · get_comments: Get issue comments · …',
        'example: via github issue:read --owner text --repo text --issue-number 1 --method get',
        'full text: via github issue:read -h --full',
        'alias: issue_read · read-only',
      ].join('\n'),
    );
  });

  it('matches the issue:list usage line from the error examples', () => {
    const ctx = { ...github, ref: 'github issue:list', rawName: 'list_issues' };
    expect(formatUsage(makeTool(ISSUE_LIST), ctx)).toBe(
      'usage: via github issue:list --owner <str> --repo <str> [--state open|closed|all] [--per-page <num>] [--title <str>]',
    );
  });

  it('shows required parameters first, with types, defaults, enums and truncated descriptions', async () => {
    const tool = makeTool(
      {
        type: 'object',
        properties: {
          body: { type: 'string', description: 'The issue body, written in Markdown. It may be long and is cut so that a help page stays readable on one line.' },
          title: { type: 'string', description: 'Title of the issue' },
          draft: { type: 'boolean', default: false },
          priority: { type: 'integer', description: 'Priority', default: 3, minimum: 0 },
          tags: { type: 'array', items: { type: 'string' } },
          pages: { type: 'array', items: { type: 'object' } },
          level: { enum: Array.from({ length: 12 }, (_, i) => `level-number-${i}`) },
        },
        required: ['title'],
        additionalProperties: false,
      },
      { name: 'issue_create', description: 'Create an issue\nwith a long body' },
    );
    expect(formatToolHelp(tool, { ...CTX, ref: 'acme issue:create', rawName: 'issue_create' })).toMatchInlineSnapshot(`
      "usage: via acme issue:create --title <str> [--body <str>] [--draft]
               [--priority <num>] [--tags <str[]>] [--pages <json>] [--level <str>]

      Create an issue
        --title      Title of the issue
        --body       The issue body, written in Markdown. It may be long and is cut so that …
        --draft      default: false
        --priority   Priority · default: 3
        --tags       repeat the flag or pass a JSON array
        --level      one of: level-number-0, level-number-1, level-number-2, level-number-3, …
      example: via acme issue:create --title text --body text --draft
      full text: via acme issue:create -h --full
      alias: issue_create"
    `);
  });

  it('lists --filter <json> with its --filter.<field> forms', () => {
    const tool = makeTool({
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          description: 'Which issues',
          properties: {
            state: { type: 'string', enum: ['open', 'closed'], description: 'Issue state' },
            per_page: { type: 'integer', default: 30 },
          },
        },
      },
      additionalProperties: false,
    });
    expect(formatToolHelp(tool, CTX)).toMatchInlineSnapshot(`
      "usage: via acme thing:do [--filter <json>]

      Do the thing
        --filter            Which issues
        --filter.state      open|closed · Issue state
        --filter.per-page   num · default: 30
      example: via acme thing:do --filter.state open
      alias: thing_do"
    `);
  });

  // arguments.md, "帮助": a required parameter always has a row, with only its type or values when the schema says nothing else.
  it('lists a required parameter without a description on its own row', () => {
    const tool = makeTool({
      type: 'object',
      properties: {
        issue_number: { type: 'integer' },
        method: { type: 'string', enum: ['get', 'get_comments'] },
        force: { type: 'boolean' },
        note: { type: 'string' },
        page: { type: 'integer', description: 'Page' },
      },
      required: ['issue_number', 'method', 'force', 'page'],
    });
    const help = formatToolHelp(tool, CTX);
    expect(help).toContain('\n  --issue-number   <num>\n');
    expect(help).toContain('\n  --method         get|get_comments\n');
    expect(help).toContain('\n  --force          bool\n');
    expect(help).toContain('\n  --page           Page\n');
    // An optional parameter with nothing to say still has no row.
    expect(help).not.toMatch(/\n {2}--note /);
  });

  it('notes that roots accept extra fields', () => {
    expect(formatToolHelp(makeTool({ type: 'object', properties: { a: { type: 'string' } } }), CTX)).toContain('accepts extra fields: --<name> <value>');
    expect(formatToolHelp(makeTool({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }), CTX)).not.toContain('extra fields');
    expect(formatToolHelp(makeTool(undefined), CTX)).toContain('accepts extra fields');
  });

  it('notes name collisions and shows the original names', () => {
    const tool = makeTool({
      type: 'object',
      properties: { per_page: { type: 'integer' }, perPage: { type: 'integer' }, owner: { type: 'string' } },
      required: ['owner'],
      additionalProperties: false,
    });
    const help = formatToolHelp(tool, CTX);
    expect(help).toContain('usage: via acme thing:do --owner <str> [--per_page <num>] [--perPage <num>]');
    expect(help).toContain('note: per_page and perPage become the same flag; pass each by its original name');
  });

  it('marks destructive tools and shows global-option names through --p.', () => {
    const tool = makeTool({ type: 'object', properties: { full: { type: 'boolean' }, timeout: { type: 'integer' } }, additionalProperties: false });
    const help = formatToolHelp(tool, { ...CTX, destructive: true });
    expect(help).toContain('usage: via acme thing:do [--p.full] [--p.timeout <num>]');
    expect(help.split('\n').at(-1)).toBe('alias: thing_do · destructive (needs --yes)');
  });

  it('leaves out alias: when the raw name is the canonical one, and the line when nothing is left', () => {
    const tool = makeTool({ type: 'object', properties: {}, additionalProperties: false });
    expect(formatToolHelp(tool, { ...CTX, ref: 'acme whoami', rawName: 'whoami', readOnly: true }).split('\n').at(-1)).toBe('read-only');
    const bare = formatToolHelp(tool, { ...CTX, ref: 'acme whoami', rawName: 'whoami' });
    expect(bare).not.toContain('alias:');
    expect(bare.endsWith('\n')).toBe(false);
    expect(formatToolHelp(tool, { ...CTX, ref: 'acme who-am-i', rawName: 'who_am_i' }).split('\n').at(-1)).toBe('alias: who_am_i');
  });

  it('wraps long usage lines at 80 columns with a 9-space indent', () => {
    const tool = makeTool({
      type: 'object',
      properties: Object.fromEntries(['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'].map((n) => [n, { type: 'string' }])),
      required: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'],
    });
    const lines = formatUsage(tool, CTX).split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(80);
    for (const l of lines.slice(1)) expect(l.startsWith(' '.repeat(9) + '--')).toBe(true);
  });

  it('renders tools with oneOf parameters and no description', () => {
    const help = formatToolHelp({ name: 'x', inputSchema: NOTION_PARENT }, { ...CTX, ref: 'notion page:create', rawName: 'notion-create-pages' });
    expect(help.split('\n')[0]).toBe('usage: via notion page:create --pages <json> [--parent <json>]');
    expect(help).toContain('--parent.page-id');
  });
});
