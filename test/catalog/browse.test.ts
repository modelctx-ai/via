import { describe, expect, it } from 'vitest';
import {
  PROVIDER_STATUSES,
  renderFind,
  renderProvider,
  renderResource,
  renderRoot,
  resolveProvider,
  resolveTarget,
  rootEntries,
  SearchIndex,
} from '../../src/catalog';
import { catalogFixture } from '../helpers/fixtures';

const all = catalogFixture('tools');

function provider(name: string) {
  const r = resolveProvider(all, name);
  if (r.kind !== 'provider') throw new Error(`no provider ${name}`);
  return r.provider;
}

describe('via (root view)', () => {
  it('lists one row per provider with its tool count', async () => {
    const entries = rootEntries(all.providers, { linear: 'needs-auth', slack: 'failed' });
    await expect(`${renderRoot(entries)}\n`).toMatchFileSnapshot('./__snapshots__/root.txt');
  });

  it('tells a provider that is starting from one that failed, with the reason after the status', async () => {
    const entries = rootEntries(
      all.providers,
      { linear: 'needs-auth', slack: 'failed', notion: 'starting', exa: 'failed' },
      { slack: 'cannot run slack-mcp (ENOENT)', notion: 'retry in a moment', exa: 'the process exited before the MCP handshake finished' },
    );
    await expect(`${renderRoot(entries)}\n`).toMatchFileSnapshot('./__snapshots__/root-starting.txt');
    const first = renderRoot(entries).split('\n')[0]!;
    expect(first).toContain('1 needs auth (linear) · 1 starting (notion) · 2 failed (exa, slack)');
  });

  it('exports the status names as one list', () => {
    expect([...PROVIDER_STATUSES]).toEqual(['ok', 'needs-auth', 'starting', 'failed', 'untrusted']);
  });

  it('sorts providers by name whatever order they were loaded in', () => {
    const few = catalogFixture('tools', ['github', 'linear', 'exa']);
    const reversed = [...rootEntries(few.providers)].reverse();
    expect(renderRoot(reversed)).toBe(renderRoot(rootEntries(few.providers)));
    expect(renderRoot(rootEntries(few.providers)).split('\n').slice(1, 4).map((l) => l.split(/\s+/)[0])).toEqual(['exa', 'github', 'linear']);
  });
});

describe('via <provider>', () => {
  it.each(['github', 'linear', 'notion', 'cloudflare', 'playwright'])('%s', async (name) => {
    await expect(`${renderProvider(provider(name))}\n`).toMatchFileSnapshot(`./__snapshots__/provider-${name}.txt`);
  });

  it('cuts a long tools: line of leaf tools', () => {
    const text = renderProvider(provider('playwright'));
    // 12 leaf names fit on the line; the rest are counted
    expect(text).toContain(`… ${provider('playwright').leaves.length - 12} more · via playwright --all`);
    expect(renderProvider(provider('playwright'), { all: true })).not.toContain('…');
  });

  it('truncates long resource lists and points at --all', () => {
    const text = renderProvider(provider('github'), { maxRows: 5 });
    const hidden = provider('github').resources.length - 5;
    expect(text.split('\n').filter((l) => l.startsWith('…'))).toEqual([`… ${hidden} more · via github --all`]);
    expect(renderProvider(provider('github'), { all: true })).not.toContain('…');
  });

  it('marks destructive actions but leaves read-only ones plain', () => {
    expect(renderProvider(provider('github'))).toMatch(/^file\s+.*delete!/m);
    expect(renderProvider(provider('linear'))).not.toContain('!');
  });
});

describe('via <provider> <resource>', () => {
  it('lists each tool with signature and short description', async () => {
    const r = resolveTarget(provider('github'), 'issue');
    if (r.kind !== 'resource') throw new Error('expected a resource');
    await expect(`${renderResource(provider('github'), r.resource)}\n`).toMatchFileSnapshot('./__snapshots__/resource-github-issue.txt');
  });

  it('ends the tools of a resource with the leaf tool of the same name, with its signature', async () => {
    const notes = catalogFixture('other', ['notes']).providers[0]!;
    const r = resolveTarget(notes, 'secret');
    if (r.kind !== 'resource') throw new Error('expected a resource');
    await expect(`${renderResource(notes, r.resource)}\n`).toMatchFileSnapshot('./__snapshots__/resource-notes-secret.txt');
  });

  it('tags read-only and destructive tools after the description and keeps names copyable', () => {
    const file = resolveTarget(provider('github'), 'file');
    if (file.kind !== 'resource') throw new Error('expected a resource');
    const text = renderResource(provider('github'), file.resource);
    expect(text).toMatch(/^file:delete\s+.*\[destructive\]$/m);
    expect(text).toMatch(/^file:create-or-update\s+[^!]*$/m);
    const issue = resolveTarget(provider('github'), 'issue');
    if (issue.kind !== 'resource') throw new Error('expected a resource');
    expect(renderResource(provider('github'), issue.resource)).toMatch(/^issue:read\s+.*\[read-only\]$/m);
  });

  it('puts required parameters first and optional ones in brackets, in kebab-case', () => {
    const r = resolveTarget(provider('github'), 'issue');
    if (r.kind !== 'resource') throw new Error('expected a resource');
    const text = renderResource(provider('github'), r.resource);
    expect(text).toMatch(/issue:read\s+method, owner, repo, issue-number, \[page\], \[per-page\]/);
    expect(text).toMatch(/issue:list\s+owner, repo, \[state\]/);
  });
});

describe('via find', () => {
  const index = new SearchIndex(all);

  it('renders hits like the resource view with a provider prefix', async () => {
    await expect(`${renderFind(index.search('pull request merge'), 'pull request merge')}\n`).toMatchFileSnapshot(
      './__snapshots__/find-pull-request-merge.txt',
    );
  });

  it('says so when nothing matches', () => {
    expect(renderFind([], 'zzzz')).toBe('no tools match "zzzz"\n→ via to list providers');
  });
});
