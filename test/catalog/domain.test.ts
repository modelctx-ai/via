import { describe, expect, it } from 'vitest';
import {
  buildLexicon,
  defaultCatalogRules,
  defaultDomainRules,
  matchBuiltin,
  renderDomainWhy,
  type DomainAssignment,
} from '../../src/catalog';
import lexicon from '../../data/domain-lexicon.json';
import { fixtureNames, providerFixture } from '../helpers/fixtures';

const domains = (a: DomainAssignment) => a.domains.map((d) => d.domain);

/** Domain of each server in the built-in table (docs/spec/discovery.md). */
const TABLE: Record<string, string> = {
  github: 'code',
  linear: 'project',
  notion: 'docs',
  cloudflare: 'cloud',
  playwright: 'browser',
  puppeteer: 'browser',
  exa: 'search',
  context7: 'search',
  tavily: 'search',
  filesystem: 'fs',
  slack: 'comm',
  gmail: 'comm',
  'google-drive': 'docs',
  postgres: 'data',
  sqlite: 'data',
};

describe('built-in classification table', () => {
  it.each(Object.entries(TABLE))('%s -> %s', (name, domain) => {
    const c = providerFixture('tools', name);
    expect(c.domain.source).toBe('builtin');
    expect(domains(c.domain)).toEqual([domain]);
  });

  it('matches by package name and URL host as well as alias', () => {
    const rules = defaultDomainRules();
    expect(matchBuiltin('db', { packages: ['@modelcontextprotocol/server-postgres'] }, rules)).toEqual(['data']);
    expect(matchBuiltin('db', { packages: ['mcp-server-sqlite'] }, rules)).toEqual(['data']);
    expect(matchBuiltin('pw', { packages: ['@playwright/mcp'] }, rules)).toEqual(['browser']);
    expect(matchBuiltin('tracker', { host: 'mcp.linear.app' }, rules)).toEqual(['project']);
    expect(matchBuiltin('wiki', { host: 'mcp.notion.com' }, rules)).toEqual(['docs']);
    expect(matchBuiltin('web', { packages: ['@acme/server-brave-search'] }, rules)).toEqual(['search']);
  });

  it('does not match on partial words', () => {
    const rules = defaultDomainRules();
    expect(matchBuiltin('githubish', undefined, rules)).toEqual([]);
    expect(matchBuiltin('x', { packages: ['githubber-mcp'] }, rules)).toEqual([]);
  });
});

describe('priority: config > built-in table > heuristic > other', () => {
  it('servers.<name>.domain overrides the built-in table', () => {
    const c = providerFixture('tools', 'github', { configDomain: 'work' });
    expect(c.domain).toEqual({ source: 'config', domains: [{ domain: 'work' }] });
  });

  it('top-level custom domains put a provider into every domain that lists it', () => {
    const c = providerFixture('tools', 'exa', { customDomains: { research: ['exa', 'context7'], daily: ['exa'] } });
    expect(c.domain.source).toBe('config');
    expect(domains(c.domain)).toEqual(['research', 'daily']);
  });

  it('falls through to other when nothing is convincing', () => {
    const c = providerFixture('other', 'acme-weather');
    expect(c.domain.source).toBe('other');
    expect(domains(c.domain)).toEqual(['other']);
  });
});

describe('heuristic scoring on servers outside the table', () => {
  it.each([
    ['acme-git', 'code'],
    ['acme-tracker', 'project'],
    ['acme-chat', 'comm'],
    ['acme-sql', 'data'],
    ['acme-puppet', 'browser'],
  ])('%s -> %s', (name, domain) => {
    const c = providerFixture('other', name);
    expect(c.domain.source).toBe('heuristic');
    expect(domains(c.domain)).toEqual([domain]);
    expect(c.domain.confidence).toBeGreaterThanOrEqual(defaultDomainRules().heuristic.threshold);
  });

  it('is not fooled by gateway meta tools', () => {
    expect(domains(providerFixture('other', 'aster').domain)).toEqual(['other']);
  });

  it('recovers the table domain for known servers when the alias is unknown', () => {
    // Sanity check of the generated lexicon: hide the alias so the table cannot answer. The three
    // excluded servers have too few tools (1, 4, 2) for their terms to outweigh shared words.
    const hidden = Object.entries(TABLE).filter(([name]) => !['postgres', 'cloudflare', 'context7'].includes(name));
    for (const [name, domain] of hidden) {
      const c = providerFixture('tools', name, { provider: `zz-${name}` });
      expect(c.domain.source, name).toBe('heuristic');
      expect(domains(c.domain), name).toEqual([domain]);
    }
  });

  it('splits a mixed server by resource and notes the relevant resources', () => {
    const c = providerFixture('other', 'acme-workspace');
    expect(c.domain.source).toBe('heuristic');
    const byDomain = Object.fromEntries(c.domain.domains.map((d) => [d.domain, d.resources]));
    expect(Object.keys(byDomain).sort()).toEqual(['comm', 'docs']);
    expect(byDomain.comm).toContain('mail-message');
    expect(byDomain.docs).toContain('drive-folder');
  });

  it('explains its verdict', () => {
    const c = providerFixture('other', 'acme-sql');
    expect(renderDomainWhy('acme-sql', c.domain)).toMatchInlineSnapshot(`
      "acme-sql → data (heuristic, 0.79)
        data      31.7   table, sql, database
        docs      5.0    param, show
        project   2.2    limit
        next: set servers.acme-sql.domain in ~/.config/via/config.yaml to override"
    `);
  });
});

describe('lexicon', () => {
  it('data/domain-lexicon.json is up to date with test/fixtures/tools (npm run lexicon)', () => {
    const rules = defaultCatalogRules();
    const samples = fixtureNames('tools').flatMap((name) => {
      const found = matchBuiltin(name, undefined, rules.domains);
      return found.length === 1
        ? [{ domain: found[0]!, tools: providerFixture('tools', name).tools }]
        : [];
    });
    const built = buildLexicon(samples, rules.domains, rules.split);
    expect(built.terms).toEqual(lexicon.terms);
  });

  it('weights terms by how exclusive they are to a domain', () => {
    const terms = lexicon.terms as Record<string, Record<string, number>>;
    expect(terms.repo).toEqual({ code: 1 });
    expect(terms.sql).toEqual({ data: 1 });
    expect(terms.selector).toEqual({ browser: 1 });
    expect(terms.channel).toEqual({ comm: 1 });
    // Shared across domains: every weight is below 1.
    expect(Math.max(...Object.values(terms.label ?? {}))).toBeLessThan(1);
  });
});
