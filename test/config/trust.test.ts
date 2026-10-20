import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkTrust, forgetTrust, hashContent, readTrustStore, recordTrust, recordTrustHash, trustKey, trustStatus, trustStorePath } from '../../src/config';
import { tempDir } from '../helpers/config';

function setup() {
  const dir = tempDir();
  const file = join(dir, 'project', '.via.yaml');
  mkdirSync(join(dir, 'project'));
  writeFileSync(file, 'servers: {}\n');
  return { dir, file, dataDir: join(dir, 'data', 'via') };
}

describe('trust store', () => {
  it('starts empty and trusts nothing', () => {
    const { file, dataDir } = setup();
    expect(readTrustStore(dataDir)).toEqual({ store: { version: 1, entries: {} } });
    expect(checkTrust(dataDir, file)).toBe('untrusted');
  });

  it('records path and content hash; a changed file needs confirming again', () => {
    const { file, dataDir } = setup();
    const record = recordTrust(dataDir, file);
    expect(record.sha256).toBe(hashContent('servers: {}\n'));
    expect(checkTrust(dataDir, file)).toBe('trusted');

    writeFileSync(file, 'servers: { x: { command: evil } }\n');
    expect(checkTrust(dataDir, file)).toBe('changed');

    recordTrust(dataDir, file);
    expect(checkTrust(dataDir, file)).toBe('trusted');
  });

  it('records the content the person was shown, not whatever is on disk now', () => {
    const { file, dataDir } = setup();
    recordTrust(dataDir, file, 'servers: {}\n');
    writeFileSync(file, 'changed after the prompt\n');
    expect(checkTrust(dataDir, file)).toBe('changed');
  });

  it('records a hash directly (the one computed over the bytes that were parsed)', () => {
    const { file, dataDir } = setup();
    const shown = hashContent('servers: {}\n');
    writeFileSync(file, 'edited after the hash was taken\n');
    recordTrustHash(dataDir, file, shown);
    expect(checkTrust(dataDir, file)).toBe('changed');
    writeFileSync(file, 'servers: {}\n');
    expect(checkTrust(dataDir, file)).toBe('trusted');
  });

  it('keeps the directory at 0700 and the file at 0600', () => {
    const { file, dataDir } = setup();
    recordTrust(dataDir, file);
    if (process.platform !== 'win32') {
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
      expect(statSync(trustStorePath(dataDir)).mode & 0o777).toBe(0o600);
    }
    const stored = JSON.parse(readFileSync(trustStorePath(dataDir), 'utf8')) as { version: number; entries: Record<string, { sha256: string }> };
    expect(stored.version).toBe(1);
    expect(Object.keys(stored.entries)).toEqual([trustKey(file)]);
  });

  it('tightens a data directory that was created too open', () => {
    const { file, dataDir } = setup();
    mkdirSync(dataDir, { recursive: true, mode: 0o755 });
    recordTrust(dataDir, file);
    if (process.platform !== 'win32') expect(statSync(dataDir).mode & 0o777).toBe(0o700);
  });

  // Creating a symlink needs elevated rights (or developer mode) on Windows.
  it.skipIf(process.platform === 'win32')('keys records by real path, so a symlink does not borrow trust', () => {
    const { dir, file, dataDir } = setup();
    recordTrust(dataDir, file);
    const link = join(dir, 'link.yaml');
    symlinkSync(file, link);
    // Same content, reached through a link to the trusted file: that is the trusted file.
    expect(trustKey(link)).toBe(trustKey(file));
    const other = join(dir, 'other.yaml');
    writeFileSync(other, 'servers: {}\n');
    expect(checkTrust(dataDir, other)).toBe('untrusted');
  });

  it('treats a corrupt store as empty and says so, and recovers on the next record', () => {
    const { file, dataDir } = setup();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(trustStorePath(dataDir), '{ not json');
    const { store, error } = readTrustStore(dataDir);
    expect(store.entries).toEqual({});
    expect(error).toContain('not a valid trust store');
    expect(checkTrust(dataDir, file)).toBe('untrusted');
    recordTrust(dataDir, file);
    expect(readTrustStore(dataDir).error).toBeUndefined();
    expect(checkTrust(dataDir, file)).toBe('trusted');
  });

  it('ignores malformed entries and the wrong version', () => {
    const { file, dataDir } = setup();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(trustStorePath(dataDir), JSON.stringify({ version: 1, entries: { [trustKey(file)]: { sha256: 5 }, '__proto__': { sha256: 'a', trustedAt: 'b' } } }));
    expect(readTrustStore(dataDir).store.entries).toEqual({});
    writeFileSync(trustStorePath(dataDir), JSON.stringify({ version: 2, entries: {} }));
    expect(readTrustStore(dataDir).error).toBeDefined();
  });

  it('forgets a record', () => {
    const { file, dataDir } = setup();
    expect(forgetTrust(dataDir, file)).toBe(false);
    recordTrust(dataDir, file);
    expect(forgetTrust(dataDir, file)).toBe(true);
    expect(trustStatus(readTrustStore(dataDir).store, file, hashContent('servers: {}\n'))).toBe('untrusted');
  });

  it('reports a missing file as untrusted', () => {
    const { dir, dataDir } = setup();
    expect(checkTrust(dataDir, join(dir, 'nope.yaml'))).toBe('untrusted');
  });
});

// Windows file systems ignore case, and one file has several spellings: drive letter case, `/` or
// `\`, `\\?\` prefixes. A record must follow the file, not the spelling (security.md, "项目级配置的信任").
describe('trust on Windows', () => {
  const sha = hashContent('servers: {}\n');
  const store = (key: string) => ({ version: 1 as const, entries: { [key]: { sha256: sha, trustedAt: '2026-01-01T00:00:00.000Z' } } });

  it('gives every spelling of one file the same key', () => {
    const key = trustKey('C:\\Users\\Me\\repo\\.via.yaml', 'win32');
    expect(key).toBe('C:\\Users\\Me\\repo\\.via.yaml');
    expect(trustKey('c:/Users/Me/repo/./.via.yaml', 'win32')).toBe(key);
    expect(trustKey('\\\\?\\C:\\Users\\Me\\repo\\.via.yaml', 'win32')).toBe(key);
    expect(trustKey('C:\\Users\\Me\\repo\\sub\\..\\.via.yaml', 'win32')).toBe(key);
  });

  it('finds a record whatever the case of the path, and still checks the content', () => {
    const records = store('C:\\Users\\Me\\Repo\\.via.yaml');
    expect(trustStatus(records, 'c:\\users\\me\\repo\\.VIA.yaml', sha, 'win32')).toBe('trusted');
    expect(trustStatus(records, 'C:/Users/Me/Repo/.via.yaml', sha, 'win32')).toBe('trusted');
    expect(trustStatus(records, 'c:\\users\\me\\repo\\.via.yaml', hashContent('other'), 'win32')).toBe('changed');
    expect(trustStatus(records, 'C:\\Users\\Me\\Other\\.via.yaml', sha, 'win32')).toBe('untrusted');
  });

  it('does not fold case on other platforms', () => {
    expect(trustStatus(store('/home/me/Repo/.via.yaml'), '/home/me/repo/.via.yaml', sha, 'linux')).toBe('untrusted');
  });
});
