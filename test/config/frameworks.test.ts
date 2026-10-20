import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { BUNDLED_FRAMEWORKS, DEFAULT_POINTERS, findFramework } from '../../src/config';

const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));
const files = readdirSync(join(dataDir, 'frameworks')).filter((f) => f.endsWith('.json')).sort();
const schema = JSON.parse(readFileSync(join(dataDir, 'schema/framework.schema.json'), 'utf8')) as object;
const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);

describe('data/frameworks', () => {
  it.each(files)('%s validates against data/schema/framework.schema.json', (file) => {
    const ok = validate(JSON.parse(readFileSync(join(dataDir, 'frameworks', file), 'utf8')));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('rejects entries that break the format', () => {
    const base = JSON.parse(readFileSync(join(dataDir, 'frameworks/cursor.json'), 'utf8')) as Record<string, unknown>;
    const bad = [
      { ...base, id: 'Cursor' },
      { ...base, configs: [] },
      { ...base, configs: [{ path: 'x', format: 'ini', pointer: '/a', scope: 'user' }] },
      { ...base, configs: [{ path: 'x', format: 'json', pointer: 'a', scope: 'user' }] },
      { ...base, configs: [{ path: 'x', format: 'json', pointer: '/a', scope: 'global' }] },
      { ...base, configs: [{ path: 'x', format: 'json', pointer: '/a', scope: 'user', platforms: ['freebsd'] }] },
      { ...base, verifiedAt: '2026-13' },
      { ...base, extra: true },
    ];
    for (const entry of bad) expect(validate(entry), JSON.stringify(entry)).toBe(false);
    expect(validate({ ...base, verifiedAt: '2026-10' })).toBe(true);
    expect(validate({ ...base, verifiedAt: null })).toBe(true);
  });

  it('has one file per framework, named after its id, and all of them are registered', () => {
    expect(files.map((f) => basename(f, '.json')).sort()).toEqual(BUNDLED_FRAMEWORKS.map((f) => f.id).sort());
    expect(new Set(BUNDLED_FRAMEWORKS.map((f) => f.id)).size).toBe(BUNDLED_FRAMEWORKS.length);
  });

  it('covers the frameworks named in config.md, in the documented order', () => {
    expect(BUNDLED_FRAMEWORKS.map((f) => f.id)).toEqual(['claude-code', 'claude-desktop', 'cursor', 'codex', 'vscode', 'windsurf']);
    expect(findFramework('cursor')?.name).toBe('Cursor');
    expect(findFramework('nope')).toBeUndefined();
  });

  it('every framework is reachable on linux and darwin, and has a user-scoped config', () => {
    for (const f of BUNDLED_FRAMEWORKS) {
      for (const platform of ['linux', 'darwin'] as const) {
        const reachable = f.configs.filter((c) => !c.platforms || c.platforms.includes(platform));
        expect(reachable.length, `${f.id} on ${platform}`).toBeGreaterThan(0);
        expect(reachable.some((c) => c.scope === 'user'), `${f.id} on ${platform}`).toBe(true);
      }
    }
  });

  it('project-scoped paths are relative; user-scoped ones start at ~ or a variable', () => {
    for (const f of BUNDLED_FRAMEWORKS) {
      for (const c of f.configs) {
        if (c.scope === 'project') expect(c.path, f.id).toMatch(/^[^~/%]/);
        else expect(c.path, f.id).toMatch(/^(~\/|%[A-Z]+%\/)/);
      }
    }
  });

  it('does not keep a dated claim it cannot back up', () => {
    for (const f of BUNDLED_FRAMEWORKS) expect(f.verifiedAt === null || /^\d{4}-\d{2}$/.test(f.verifiedAt)).toBe(true);
  });

  it('default pointers for files given by path cover the three spellings', () => {
    expect(DEFAULT_POINTERS).toEqual(['/mcpServers', '/servers', '/mcp_servers']);
  });
});
