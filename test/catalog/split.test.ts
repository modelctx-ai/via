import { describe, expect, it } from 'vitest';
import { defaultSplitRules, splitToolName, type SplitResult } from '../../src/catalog';

const rules = defaultSplitRules();

function canon(raw: string, provider: string, aliases: string[] = []): string {
  const r: SplitResult = splitToolName(raw, { providerNames: [provider, ...aliases] }, rules);
  return r.kind === 'resource' ? `${r.resource}:${r.verb}` : `${r.leafName} (leaf)`;
}

describe('splitToolName: naming.md examples', () => {
  // Every row of the example table in docs/spec/naming.md.
  it.each([
    ['create_issue', 'linear', 'issue:create'],
    ['linear_list_issues', 'linear', 'issue:list'],
    ['list_my_issues', 'linear', 'my-issue:list'],
    ['issue_read', 'github', 'issue:read'],
    ['get_pull_request_comments', 'github', 'pull-request-comment:get'],
    ['create_or_update_file', 'github', 'file:create-or-update'],
    ['actions_run_trigger', 'github', 'action-run:trigger'],
    ['get_job_logs', 'github', 'job-log:get'],
    ['notion-create-pages', 'notion', 'page:create'],
    ['notion-calendar-list-events', 'notion', 'calendar-event:list'],
    ['notion-search', 'notion', 'search (leaf)'],
    ['web_search_exa', 'exa', 'web:search'],
    ['browser_navigate', 'playwright', 'browser:navigate'],
    ['sequentialthinking', 'sequential-thinking', 'sequentialthinking (leaf)'],
  ])('%s (%s) -> %s', (raw, provider, expected) => {
    expect(canon(raw, provider)).toBe(expected);
  });
});

describe('splitToolName: rules', () => {
  it('tokenizes snake, kebab, dotted and camel case alike', () => {
    for (const raw of ['create_issue', 'create-issue', 'create.issue', 'createIssue', 'CreateIssue']) {
      expect(canon(raw, 'linear')).toBe('issue:create');
    }
  });

  it('keeps acronyms together when tokenizing camel case', () => {
    expect(canon('listHTTPRoutes', 'acme')).toBe('http-route:list');
  });

  it('strips the provider word from the start or the end, never the middle', () => {
    expect(canon('web_search_exa', 'exa')).toBe('web:search');
    expect(canon('exa_web_search', 'exa')).toBe('web:search');
    expect(canon('web_exa_search', 'exa')).toBe('web-exa:search');
  });

  it('strips provider aliases and multi-word provider names', () => {
    expect(canon('lin_create_issue', 'linear', ['lin'])).toBe('issue:create');
    expect(canon('brave_search_get_news', 'brave-search')).toBe('news:get');
  });

  it('never strips the whole name', () => {
    expect(canon('notion', 'notion')).toBe('notion (leaf)');
  });

  it('prefers the first word as verb, then the last, then the first verb found', () => {
    expect(canon('get_issue_comments', 'x')).toBe('issue-comment:get');
    expect(canon('issue_comment_get', 'x')).toBe('issue-comment:get');
    expect(canon('calendar_list_events', 'x')).toBe('calendar-event:list');
  });

  it('merges verbs joined by or / and into a compound verb', () => {
    expect(canon('create_or_update_file', 'github')).toBe('file:create-or-update');
    expect(canon('file_create_or_update', 'github')).toBe('file:create-or-update');
    expect(canon('get_and_list_items', 'x')).toBe('item:get-and-list');
  });

  it('drops adjacent duplicate words after singularising', () => {
    expect(canon('notion-calendar-list-calendars', 'notion')).toBe('calendar:list');
    expect(canon('list_issues_issue', 'x')).toBe('issue:list');
  });

  it('makes tools without a verb or without a resource into leaf tools', () => {
    expect(canon('sequentialthinking', 'x')).toBe('sequentialthinking (leaf)');
    expect(canon('whoami', 'cloudflare')).toBe('whoami (leaf)');
    expect(canon('search', 'cloudflare')).toBe('search (leaf)');
    expect(canon('get', 'x')).toBe('get (leaf)');
    expect(canon('check_mcp_next_steps', 'x')).toBe('check-mcp-next-steps (leaf)');
  });
});

describe('splitToolName: a plural provider word after a bare verb is the resource (naming.md, rule 2)', () => {
  it('keeps the provider word the verb acts on', () => {
    expect(canon('close_todos', 'todos')).toBe('todo:close');
    expect(canon('complete_todos', 'todos')).toBe('todo:complete');
    expect(canon('todos_close_todos', 'todos')).toBe('todo:close');
    expect(canon('search_docs', 'docs')).toBe('doc:search');
  });

  it('keeps the same resource for the singular spelling, which is not a provider word', () => {
    expect(canon('create_todo', 'todos')).toBe('todo:create');
    expect(canon('close_todo', 'todos')).toBe('todo:close');
  });

  it('still drops a provider word in front of the verb, or a singular one', () => {
    expect(canon('todos_close', 'todos')).toBe('close (leaf)');
    expect(canon('notion-search', 'notion')).toBe('search (leaf)');
    expect(canon('acme_search', 'acme')).toBe('search (leaf)');
    expect(canon('search_exa', 'exa')).toBe('search (leaf)');
    expect(canon('todos', 'todos')).toBe('todos (leaf)');
  });

  it('keeps the leaf name the rules give when the tool falls back to a leaf', () => {
    const r = splitToolName('close_todos', { providerNames: ['todos'] }, rules);
    expect(r).toEqual({ kind: 'resource', resource: 'todo', verb: 'close', leafName: 'close' });
  });
});

describe('splitToolName: verbs for state changes', () => {
  it.each([
    ['set_secret', 'secret:set'],
    ['confirm_builds', 'build:confirm'],
    ['complete_todos', 'todo:complete'],
    ['reopen_todos', 'todo:reopen'],
    ['assign_issue', 'issue:assign'],
    ['approve_requests', 'request:approve'],
  ])('%s -> %s', (raw, expected) => {
    expect(canon(raw, 'acme')).toBe(expected);
  });
});
