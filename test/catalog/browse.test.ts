import { describe, expect, it } from 'vitest';
import {
  defaultDomainRules,
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

const rules = defaultDomainRules();
const all = catalogFixture('tools');

function provider(name: string) {
  const r = resolveProvider(all, name);
  if (r.kind !== 'provider') throw new Error(`no provider ${name}`);
  return r.provider;
}

describe('via (root view)', () => {
  it('groups providers by domain when there are many', async () => {
    const entries = rootEntries(all.providers, { linear: 'needs-auth', slack: 'error' });
    await expect(`${renderRoot(entries, rules)}\n`).toMatchFileSnapshot('./__snapshots__/root-grouped.txt');
  });

  it('lists providers flat, with their domain, when there are few (ADR 0006)', async () => {
    const few = catalogFixture('tools', ['github', 'linear', 'exa']);
    const entries = rootEntries(few.providers, { linear: 'needs-auth' });
    await expect(`${renderRoot(entries, rules)}\n`).toMatchFileSnapshot('./__snapshots__/root-flat.txt');
  });

  it('shows a provider split across domains under each of them', async () => {
    const mixed = catalogFixture('other', ['acme-workspace', 'acme-git']);
    const text = renderRoot(rootEntries(mixed.providers), { ...rules, heuristic: { ...rules.heuristic, flatBelowProviders: 0 } });
    await expect(`${text}\n`).toMatchFileSnapshot('./__snapshots__/root-split-domains.txt');
  });
});

describe('via <provider>', () => {
  it.each(['github', 'linear', 'notion', 'cloudflare', 'playwright'])('%s', async (name) => {
    await expect(`${renderProvider(provider(name))}\n`).toMatchFileSnapshot(`./__snapshots__/provider-${name}.txt`);
  });

  it('cuts a long tools: line of leaf tools', () => {
    const text = renderProvider(provider('playwright'));
    expect(text).toContain('… 6 more · via playwright --all');
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
