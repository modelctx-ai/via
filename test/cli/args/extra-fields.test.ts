import { describe, expect, it } from 'vitest';
import { failure, parse } from './helpers';

// arguments.md, "JSON 输入": a flag other CLIs share, sent as an extra field, is warned about.
describe('common flags sent as extra fields', () => {
  const loose = { type: 'object', properties: { owner: { type: 'string' } }, required: ['owner'] };

  it('warns once per flag, names the flag and how to silence it, and still sends the field', async () => {
    const r = await parse(loose, ['--owner', 'acme', '--verbose', '--limit', '5', '--verbose']);
    expect(r.args).toEqual({ owner: 'acme', verbose: true, limit: 5 });
    expect(r.warnings).toEqual([
      '--verbose is not a parameter of acme thing:do; it was sent as an extra field (write --p.verbose to silence this)',
      '--limit is not a parameter of acme thing:do; it was sent as an extra field (write --p.limit to silence this)',
    ]);
    expect(r.extraFields).toEqual(['verbose', 'limit']);
  });

  it('writing --p.<name> is the silent form, and the field is still listed as extra', async () => {
    const r = await parse(loose, ['--owner', 'acme', '--p.verbose']);
    expect(r.args).toEqual({ owner: 'acme', verbose: true });
    expect(r.warnings).toEqual([]);
    expect(r.extraFields).toEqual(['verbose']);
  });

  it('matches any spelling of a listed flag, and its --no- form', async () => {
    const r = await parse(loose, ['--owner', 'acme', '--dry_run', '--noColor', '--no-verbose']);
    expect(r.warnings.map((w) => w.split(' ')[0])).toEqual(['--dry_run', '--noColor', '--no-verbose']);
  });

  it('does not warn about an extra field that is not on the table, or about a declared parameter', async () => {
    const r = await parse({ type: 'object', properties: { owner: { type: 'string' }, limit: { type: 'integer' } } }, ['--limit', '3', '--payload', '{"a":1}']);
    expect(r.warnings).toEqual([]);
    expect(r.extraFields).toEqual(['payload']);
  });

  it('never echoes the value of the flag', async () => {
    const r = await parse(loose, ['--owner', 'acme', '--format', 'SECRET-LOOKING-VALUE-123', '--debug=another-secret-value']);
    expect(r.warnings.join('\n')).not.toMatch(/SECRET-LOOKING|another-secret/);
    expect(r.warnings).toHaveLength(2);
  });

  it('a closed schema keeps the unknown-argument error, with the did-you-mean', async () => {
    const closed = { type: 'object', properties: { owner: { type: 'string' }, per_page: { type: 'integer' } }, additionalProperties: false };
    const e = await failure(closed, ['--verbose', '--per-pag', '3']);
    expect(e.issues.map((i) => i.message)).toEqual(['unknown argument', 'unknown argument; did you mean --per-page?']);
  });

  it('--no-validate sends the flag too, and says so', async () => {
    const closed = { type: 'object', properties: { owner: { type: 'string' } }, additionalProperties: false };
    const r = await parse(closed, ['--verbose'], { validate: false });
    expect(r.warnings).toEqual(['--verbose is not a parameter of acme thing:do; it was sent as an extra field (write --p.verbose to silence this)']);
  });

  it('a flag nested in a declared object is not a root extra field', async () => {
    const r = await parse({ type: 'object', properties: { filter: { type: 'object' } } }, ['--filter.verbose', 'x']);
    expect(r.warnings).toEqual([]);
    expect(r.extraFields).toEqual([]);
  });
});
