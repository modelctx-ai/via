import { describe, expect, it } from 'vitest';
import { DEFAULTS, hasErrors, type ConfigDiagnostic } from '../../src/config';
import { validateLayer } from '../../src/config/layer';
import { makeTree } from '../helpers/config';

const semantic = (value: unknown) => validateLayer({ search: { semantic: value } }, '/c.yaml');
const messages = (value: unknown) => semantic(value).diagnostics.map((d) => `${d.level}: ${d.message}`);
const good = { provider: 'openai-compatible', url: 'https://api.example.invalid/v1', model: 'embed-small', auth: { bearer: 'env:EMB_KEY' } };

const YAML = `search:
  semantic:
    provider: openai-compatible
    url: https://api.example.invalid/v1
    model: embed-small
    auth: { bearer: "env:EMB_KEY" }
`;

describe('search.semantic validation (config.md)', () => {
  it('accepts the documented shape and fills the defaults at load time', async () => {
    const { data, diagnostics } = semantic(good);
    expect(diagnostics).toEqual([]);
    expect(data.search.semantic).toEqual({ url: good.url, model: good.model, auth: { type: 'bearer', bearer: 'env:EMB_KEY' } });
    const tree = makeTree({ 'home/.config/via/config.yaml': `sources: false\n${YAML}` });
    const config = await tree.load();
    expect(config.search?.semantic).toEqual({
      provider: 'openai-compatible',
      url: good.url,
      model: 'embed-small',
      auth: { type: 'bearer', bearer: 'env:EMB_KEY' },
      timeout: DEFAULTS.semantic.timeout,
      indexTimeout: DEFAULTS.semantic.indexTimeout,
      origin: { scope: 'user', path: `${tree.home}/.config/via/config.yaml` },
    });
  });

  it('takes optional timeouts, dimensions and header auth; auth defaults to none', () => {
    const { data, diagnostics } = semantic({ url: 'https://h.invalid', model: 'm', timeout: 1.5, indexTimeout: 60, dimensions: 256, auth: { headers: { 'api-key': 'env:K' } } });
    expect(diagnostics).toEqual([]);
    expect(data.search.semantic).toMatchObject({ timeout: 1.5, indexTimeout: 60, dimensions: 256, auth: { type: 'headers', headers: { 'api-key': 'env:K' } } });
    expect((semantic({ url: 'http://localhost:11434/v1', model: 'm' }).data.search.semantic as { auth: unknown }).auth).toEqual({ type: 'none' });
  });

  it('can be switched off with false', () => {
    expect(semantic(false).data.search.semantic).toBe(false);
  });

  it('requires url and model', () => {
    expect(messages({ model: 'm' })).toEqual(['error: search.semantic.url: expected non-empty string']);
    expect(messages({ url: 'https://h.invalid' })).toEqual(['error: search.semantic.model: expected non-empty string']);
    expect(semantic({ model: 'm' }).data.search.semantic).toBeUndefined();
  });

  it('only knows the openai-compatible provider', () => {
    expect(messages({ ...good, provider: 'cohere' })).toEqual(['error: search.semantic.provider: expected "openai-compatible"']);
  });

  it('accepts https, and http only for loopback hosts', () => {
    for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1']) expect(messages({ ...good, url }), url).toEqual([]);
    for (const url of ['http://api.example.invalid/v1', 'ftp://h.invalid', 'not a url', 'api.example.invalid/v1']) {
      expect(messages({ ...good, url }), url).toEqual(['error: search.semantic.url: expected https URL (http is accepted for localhost only)']);
    }
  });

  it('rejects credentials in the url', () => {
    expect(messages({ ...good, url: 'https://user:pass@h.invalid/v1' })).toEqual(['error: search.semantic.url: expected URL without credentials (put them in auth)']);
  });

  it('rejects oauth, bad numbers and a non-map; warns about unknown fields and literal credentials', () => {
    expect(messages({ ...good, auth: 'oauth' })).toEqual(['error: search.semantic.auth: expected none, or a map with bearer or headers']);
    expect(messages({ ...good, timeout: 'fast' })).toEqual(['error: search.semantic.timeout: expected number']);
    expect(messages({ ...good, dimensions: 1.5 })).toEqual(['error: search.semantic.dimensions: expected positive integer']);
    expect(messages('yes')).toEqual(['error: search.semantic: expected map (or false)']);
    expect(messages({ ...good, topK: 5 })).toEqual(['warning: search.semantic.topK: unknown field']);
    expect(messages({ ...good, auth: { bearer: 'sk-live-literal-value' } })).toEqual([
      'warning: search.semantic.auth.bearer: is a literal value; use env:, file: or keychain: so the token is not stored in the config',
    ]);
    expect(validateLayer({ search: { nope: 1 } }, '/c.yaml').diagnostics.map((d) => d.message)).toEqual(['search.nope: unknown field']);
    expect(validateLayer({ search: 3 }, '/c.yaml').diagnostics.map((d) => d.message)).toEqual(['search: expected map']);
  });
});

describe('search.semantic is read from the user config only (security.md)', () => {
  const codes = (diagnostics: readonly ConfigDiagnostic[]) => diagnostics.map((d) => `${d.level}:${d.code}`);

  it('ignores a project config that asks for it, with a warning', async () => {
    const tree = makeTree({ 'home/.config/via/config.yaml': 'sources: false\n', 'project/.via.yaml': YAML });
    const config = await tree.load();
    expect(config.search?.semantic).toBeUndefined();
    expect(codes(config.diagnostics)).toContain('warning:search-forbidden');
    expect(hasErrors(config.diagnostics)).toBe(false);
    expect(config.diagnostics.find((d) => d.code === 'search-forbidden')?.file).toBe(`${tree.project}/.via.yaml`);
  });

  it('a project config cannot override or remove the user setting', async () => {
    const tree = makeTree({
      'home/.config/via/config.yaml': `sources: false\n${YAML}`,
      'project/.via.yaml': 'search:\n  semantic: { url: "https://evil.example.invalid/v1", model: other }\n',
    });
    const config = await tree.load();
    expect(config.search?.semantic?.url).toBe(good.url);
    const off = makeTree({ 'home/.config/via/config.yaml': `sources: false\n${YAML}`, 'project/.via.yaml': 'search:\n  semantic: false\n' });
    expect((await off.load()).search?.semantic?.url).toBe(good.url);
  });

  it('framework configs have no search section to read', async () => {
    const tree = makeTree({ 'home/.cursor/mcp.json': JSON.stringify({ mcpServers: {}, search: { semantic: good } }), 'home/.config/via/config.yaml': 'sources: [cursor]\n' });
    expect((await tree.load()).search?.semantic).toBeUndefined();
  });

  it('command-line overrides count as user settings, and false switches it off', async () => {
    const tree = makeTree({ 'home/.config/via/config.yaml': `sources: false\n${YAML}` });
    expect((await tree.load({ cliOverrides: { search: { semantic: false } } })).search?.semantic).toBeUndefined();
  });
});
