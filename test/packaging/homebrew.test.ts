import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fetchTarball, PACKAGE, renderFormula, sha256Hex, sha512Integrity, tarballUrl } from '../../scripts/render-homebrew.mjs';

// The Homebrew formula (packaging/homebrew/via.rb.in, rendered by scripts/render-homebrew.mjs at
// release time; docs/development/implementation.md, "Homebrew"). Homebrew itself is not available
// in CI, so these tests pin what can be checked without it: the placeholders, the URL the registry
// serves, the fields `brew audit` looks at, and Ruby's own syntax check when Ruby is installed.

const root = fileURLToPath(new URL('../..', import.meta.url));
const template = readFileSync(join(root, 'packaging/homebrew/via.rb.in'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; version: string; license: string };
const SHA = 'a'.repeat(64);

describe('renderFormula', () => {
  it('fills in the version and the checksum and leaves no placeholder', () => {
    const text = renderFormula(template, { version: '1.2.3', sha256: SHA });
    expect(text).toContain(`url "${tarballUrl('1.2.3')}"`);
    expect(text).toContain(`sha256 "${SHA}"`);
    expect(text).not.toMatch(/@[A-Z0-9_]+@/);
  });

  it('refuses a malformed version or checksum and an unknown placeholder', () => {
    expect(() => renderFormula(template, { version: 'v1.2.3', sha256: SHA })).toThrow(/not a version/);
    expect(() => renderFormula(template, { version: '1.2', sha256: SHA })).toThrow(/not a version/);
    expect(() => renderFormula(template, { version: '1.2.3', sha256: 'A'.repeat(64) })).toThrow(/SHA-256/);
    expect(() => renderFormula(template, { version: '1.2.3', sha256: 'abc' })).toThrow(/SHA-256/);
    expect(() => renderFormula(`${template}\n# @OTHER@`, { version: '1.2.3', sha256: SHA })).toThrow(/@OTHER@/);
  });

  it('describes the package that is published and what the formula installs', () => {
    expect(PACKAGE).toBe(pkg.name);
    expect(tarballUrl(pkg.version)).toBe(`https://registry.npmjs.org/${pkg.name}/-/via-${pkg.version}.tgz`);
    const text = renderFormula(template, { version: pkg.version, sha256: SHA });
    expect(text).toMatch(/^class Via < Formula$/m);
    expect(text).toContain(`license "${pkg.license}"`);
    expect(text).toContain('depends_on "node"');
    expect(text).toContain('system "npm", "install", *std_npm_args');
    expect(text).toContain('bin.install_symlink libexec.glob("bin/*")');
    expect(text).toContain('shell_output("#{bin}/via --version")');
    // `brew audit`: no article or the formula's own name first, no trailing period, at most 80 characters
    const desc = /^\s*desc "(.+)"$/m.exec(text)![1]!;
    expect(desc.length).toBeLessThanOrEqual(80);
    expect(desc).not.toMatch(/^(a|an|the|via)\b/i);
    expect(desc).not.toMatch(/\.$/);
  });

  const ruby = spawnSync('ruby', ['--version'], { encoding: 'utf8' });
  it.skipIf(ruby.status !== 0)('renders Ruby that parses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'via-formula-'));
    try {
      const file = join(dir, 'via.rb');
      writeFileSync(file, renderFormula(template, { version: pkg.version, sha256: SHA }));
      const check = spawnSync('ruby', ['-c', file], { encoding: 'utf8' });
      expect(check.stdout + check.stderr).toContain('Syntax OK');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fetchTarball', () => {
  const body = Buffer.from('pretend this is a tarball');
  const response = (ok: boolean, payload: unknown, status = 200) =>
    ({ ok, status, json: async () => payload, arrayBuffer: async () => new Uint8Array(payload as Buffer).buffer }) as unknown as Response;
  const registry = (integrity: string, calls: string[] = []): typeof fetch =>
    (async (url: string) => {
      calls.push(url);
      return url.endsWith('.tgz') ? response(true, body) : response(true, { dist: { tarball: tarballUrl('1.2.3'), integrity } });
    }) as unknown as typeof fetch;

  it('returns the tarball when the registry integrity matches, and the checksum is the SHA-256 of those bytes', async () => {
    const calls: string[] = [];
    const tarball = await fetchTarball('1.2.3', { fetchImpl: registry(sha512Integrity(body), calls), retries: 1 });
    expect(tarball.equals(body)).toBe(true);
    expect(sha256Hex(tarball)).toMatch(/^[0-9a-f]{64}$/);
    expect(calls).toEqual(['https://registry.npmjs.org/@modelctx-ai%2fvia/1.2.3', tarballUrl('1.2.3')]);
  });

  it('refuses bytes that do not match the integrity, and a tarball URL other than the one the formula uses', async () => {
    await expect(fetchTarball('1.2.3', { fetchImpl: registry(sha512Integrity(Buffer.from('other'))), retries: 1 })).rejects.toThrow(/integrity/);
    const elsewhere = (async () => response(true, { dist: { tarball: 'https://example.test/via.tgz', integrity: sha512Integrity(body) } })) as unknown as typeof fetch;
    await expect(fetchTarball('1.2.3', { fetchImpl: elsewhere, retries: 1 })).rejects.toThrow(/differs/);
  });

  it('retries while the version is not on the registry yet', async () => {
    let attempts = 0;
    const lagging = (async (url: string) => {
      if (!url.endsWith('.tgz')) {
        attempts += 1;
        if (attempts < 3) return response(false, {}, 404);
        return response(true, { dist: { tarball: tarballUrl('1.2.3'), integrity: sha512Integrity(body) } });
      }
      return response(true, body);
    }) as unknown as typeof fetch;
    const tarball = await fetchTarball('1.2.3', { fetchImpl: lagging, retries: 5, delayMs: 1 });
    expect(tarball.equals(body)).toBe(true);
    expect(attempts).toBe(3);
    await expect(fetchTarball('9.9.9', { fetchImpl: (async () => response(false, {}, 404)) as unknown as typeof fetch, retries: 2, delayMs: 1 })).rejects.toThrow(/404/);
  });
});
