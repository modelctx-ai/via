import { describe, expect, it } from 'vitest';
import { checkDenyPattern, MAX_DENY_PATTERN_LENGTH } from '../../src/config/deny-safety';
import { hasErrors } from '../../src/config/diagnostics';
import { makeTree } from '../helpers/config';

// Deny rules come from project configs too, so a rule must not be able to stall via
// (config.md, "deny": regular expression safety).

describe('deny rules: ReDoS guard', () => {
  it('accepts the rules the documentation recommends', () => {
    for (const ok of [
      '^github/.*:delete$',
      '^notion/page:(delete|move)$',
      '^github/delete_file$',
      '^(gh|github)/(issue|pr):(close|delete)$',
      '_(delete|remove)s?$',
      '^db/.*(drop|truncate).*$',
      '^[a-z]+/[a-z-]+:delete$',
      '(?:foo|bar)+',
    ]) {
      expect(checkDenyPattern(ok), ok).toBeUndefined();
    }
  });

  it('rejects nested quantifiers', () => {
    for (const bad of ['^(a+)+$', '(a*)*b', '^(\\w+\\s?)*$', '(.*a){12}', '^([a-z]+)*$', '(x+x+)+y', '((a+))+']) {
      expect(checkDenyPattern(bad), bad).toMatch(/nested/);
    }
  });

  it('rejects overlapping alternatives under a repeat', () => {
    for (const bad of ['^(a|a)*$', '^(a|aa)+$', '(a|b.)+c', '^(\\d|\\d\\d)+$']) {
      expect(checkDenyPattern(bad), bad).toMatch(/alternati/);
    }
  });

  it('rejects back-references, too many open-ended quantifiers and over-long patterns', () => {
    expect(checkDenyPattern('^(a)\\1$')).toMatch(/back-?reference/);
    expect(checkDenyPattern('(?<x>a)\\k<x>')).toMatch(/back-?reference/);
    expect(checkDenyPattern('.*.*.*.*x')).toMatch(/open-ended/);
    expect(checkDenyPattern(`^${'a'.repeat(MAX_DENY_PATTERN_LENGTH)}$`)).toMatch(/longer than/);
  });

  it('does not mistake escaped or classed characters for syntax', () => {
    expect(checkDenyPattern('^a\\+\\+$')).toBeUndefined();
    expect(checkDenyPattern('^[+*()|]+$')).toBeUndefined();
    expect(checkDenyPattern('^(\\(a\\+\\))$')).toBeUndefined();
  });

  it('a catastrophic rule in a project config is an error diagnostic and is not compiled', async () => {
    const tree = makeTree({ 'home/.config/via/config.yaml': 'sources: false\ndeny: ["^ok/"]\n', 'project/.via.yaml': 'deny: ["^(a+)+$", "^also/"]\n' });
    const config = await tree.load();
    expect(config.deny.map((re) => re.source)).toEqual(['^ok\\/', '^also\\/']);
    const bad = config.diagnostics.filter((d) => d.code === 'unsafe-deny');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ level: 'error', file: expect.stringContaining('.via.yaml') });
    // Fail closed: the CLI refuses to run with this diagnostic (app.config()).
    expect(hasErrors(config.diagnostics)).toBe(true);
  });
});
