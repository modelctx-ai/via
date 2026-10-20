import { describe, expect, it } from 'vitest';
import { formatSplitTable } from '../../src/catalog';
import { fixtureNames, providerFixture } from '../helpers/fixtures';

/** `raw name -> tool part` rows copied from the provider guides (docs/guides/providers). */
const GUIDE_SPLITS: Record<string, Record<string, string>> = {
  github: {
    issue_read: 'issue:read',
    issue_write: 'issue:write',
    list_issues: 'issue:list',
    search_issues: 'issue:search',
    add_issue_comment: 'issue-comment:add',
    update_issue_comment: 'issue-comment:update',
    pull_request_read: 'pull-request:read',
    create_pull_request: 'pull-request:create',
    list_pull_requests: 'pull-request:list',
    merge_pull_request: 'pull-request:merge',
    search_pull_requests: 'pull-request:search',
    update_pull_request: 'pull-request:update',
    create_or_update_file: 'file:create-or-update',
    push_files: 'file:push',
    delete_file: 'file:delete',
    get_file_contents: 'file-content:get',
    get_commit: 'commit:get',
    list_commits: 'commit:list',
    actions_list: 'action:list',
    actions_get: 'action:get',
    actions_run_trigger: 'action-run:trigger',
    get_job_logs: 'job-log:get',
  },
  linear: {
    create_issue: 'issue:create',
    list_issues: 'issue:list',
    get_issue: 'issue:get',
    update_issue: 'issue:update',
    list_my_issues: 'my-issue:list',
    create_comment: 'comment:create',
    list_comments: 'comment:list',
    list_projects: 'project:list',
    create_project: 'project:create',
    update_project: 'project:update',
    list_cycles: 'cycle:list',
    list_documents: 'document:list',
    get_document: 'document:get',
    list_teams: 'team:list',
  },
  notion: {
    'notion-create-pages': 'page:create',
    'notion-update-page': 'page:update',
    'notion-move-pages': 'page:move',
    'notion-duplicate-page': 'page:duplicate',
    'notion-delete-pages': 'page:delete',
    'notion-restore-pages': 'page:restore',
    'notion-query-data-sources': 'data-source:query',
    'notion-update-data-source': 'data-source:update',
    'notion-create-database': 'database:create',
    'notion-create-comment': 'comment:create',
    'notion-get-comments': 'comment:get',
    'notion-create-view': 'view:create',
    'notion-update-view': 'view:update',
    'notion-calendar-list-events': 'calendar-event:list',
    'notion-calendar-create-events': 'calendar-event:create',
    'notion-calendar-update-events': 'calendar-event:update',
    'notion-calendar-cancel-events': 'calendar-event:cancel',
    'notion-get-users': 'user:get',
    'notion-get-teams': 'team:get',
    'notion-search': 'search',
    'notion-fetch': 'fetch',
  },
  cloudflare: { search: 'search', execute: 'execute', docs: 'docs', whoami: 'whoami' },
};

describe('real tools/list fixtures: guide splits', () => {
  for (const [provider, expected] of Object.entries(GUIDE_SPLITS)) {
    it(`${provider} matches docs/guides/providers`, () => {
      const catalog = providerFixture('tools', provider);
      const actual = Object.fromEntries(catalog.tools.map((t) => [t.rawName, t.name]));
      for (const [raw, tool] of Object.entries(expected)) expect(actual[raw], raw).toBe(tool);
    });
  }

  it('cloudflare has only leaf tools, in tools/list order', () => {
    const catalog = providerFixture('tools', 'cloudflare');
    expect(catalog.resources).toEqual([]);
    expect(catalog.leaves.map((t) => t.name)).toEqual(['search', 'execute', 'docs', 'whoami']);
  });

  it('gateway meta tools follow the generic rules (docs/guides/providers/gateways.md)', () => {
    const catalog = providerFixture('other', 'aster');
    expect(catalog.resources.map((r) => [r.name, r.tools.map((t) => t.verb)])).toEqual([
      ['asl', ['search', 'describe', 'call', 'batch', 'fetch']],
    ]);
    expect(catalog.leaves.map((t) => t.name)).toEqual(['asl-status']);
  });
});

describe('split snapshots (offline split check, naming.md)', () => {
  for (const dir of ['tools', 'other']) {
    for (const name of fixtureNames(dir)) {
      it(`${dir}/${name}`, async () => {
        const catalog = providerFixture(dir, name);
        await expect(formatSplitTable(catalog)).toMatchFileSnapshot(`../fixtures/splits/${name}.txt`);
      });
    }
  }

  it('no conflicts demote tools to leaf unexpectedly in the github fixture', () => {
    const catalog = providerFixture('tools', 'github');
    const leaves = catalog.leaves.map((t) => t.rawName);
    expect(leaves).toEqual(['request_copilot_review']);
  });
});
