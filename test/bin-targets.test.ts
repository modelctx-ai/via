import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { binaryName, hostTarget, keyringStub, lockedKeyring, matchesIntegrity, TARGETS, targetByName } from '../scripts/lib/bin-targets';

// The table behind `npm run build:bin --all` (scripts/build-bin.ts); the build itself needs Bun and
// is exercised by test/cli/bin.test.ts.
describe('executable targets', () => {
  it('names the binaries via-<os>-<arch>[-musl][.exe]', () => {
    expect(TARGETS.map(binaryName)).toEqual([
      'via-linux-x64',
      'via-linux-arm64',
      'via-linux-x64-musl',
      'via-linux-arm64-musl',
      'via-darwin-x64',
      'via-darwin-arm64',
      'via-windows-x64.exe',
    ]);
  });

  it('maps each target to a Bun target and a keyring package that exist in package-lock.json', () => {
    const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as unknown;
    for (const target of TARGETS) {
      expect(target.bun).toBe(`bun-${target.name}`);
      const pinned = lockedKeyring(lock, target);
      expect(pinned.name).toBe(`@napi-rs/keyring-${target.keyring}`);
      expect(pinned.integrity).toMatch(/^sha512-/);
      expect(pinned.resolved).toContain(`keyring-${target.keyring}-${pinned.version}.tgz`);
    }
  });

  it('picks the host target, glibc or musl on Linux', () => {
    expect(hostTarget('linux', 'x64').name).toBe('linux-x64');
    expect(hostTarget('linux', 'arm64', true).name).toBe('linux-arm64-musl');
    expect(hostTarget('darwin', 'arm64', true).name).toBe('darwin-arm64');
    expect(hostTarget('win32', 'x64').name).toBe('windows-x64');
    expect(() => hostTarget('linux', 'ia32')).toThrow(/no executable target for linux\/ia32/);
    expect(() => hostTarget('freebsd', 'x64')).toThrow(/no executable target/);
    expect(() => targetByName('plan9-mips')).toThrow(/unknown target "plan9-mips"/);
  });

  it('checks downloaded bytes against the lockfile integrity', () => {
    const data = new TextEncoder().encode('native module');
    const integrity = `sha512-${createHash('sha512').update(data).digest('base64')}`;
    expect(matchesIntegrity(data, integrity)).toBe(true);
    expect(matchesIntegrity(new TextEncoder().encode('tampered'), integrity)).toBe(false);
    expect(matchesIntegrity(data, 'md5-abc')).toBe(false);
  });

  it('substitutes the keyring module with a require of the target .node file', () => {
    const stub = keyringStub('/cache/keyring.darwin-arm64.node');
    expect(stub).toContain('require("/cache/keyring.darwin-arm64.node")');
    expect(stub).toContain('NAPI_RS_NATIVE_LIBRARY_PATH');
    expect(stub).toContain('module.exports.AsyncEntry = binding.AsyncEntry;');
  });
});
