import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FAKE_SECRET } from './helpers/render';

// testing.md, "安全相关测试": no credential value may appear in a snapshot or fixture.

const testDir = fileURLToPath(new URL('.', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const snapshots = walk(testDir).filter(
  (p) => p.includes('__snapshots__') || p.includes(`${join('fixtures', 'splits')}`) || p.endsWith('.snap'),
);

/** Shapes of real credentials. Matching one in a snapshot is a leak, whatever the value. */
const CREDENTIAL_PATTERNS: Array<[string, RegExp]> = [
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{20,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

describe('snapshots and fixtures', () => {
  it('finds the snapshot files this scan is meant to cover', () => {
    expect(snapshots.length).toBeGreaterThan(10);
  });

  it.each(snapshots.map((p) => [p.slice(testDir.length), p]))('%s holds no credential', (_name, path) => {
    const text = readFileSync(path!, 'utf8');
    expect(text).not.toContain(FAKE_SECRET);
    for (const [label, pattern] of CREDENTIAL_PATTERNS) expect(pattern.test(text), label).toBe(false);
  });
});

// bench/ holds canned tool results, task scripts and the recorded results. They are checked in and
// quoted in docs, so they get the same scan as the snapshots.
const benchDir = fileURLToPath(new URL('../bench/', import.meta.url));
const benchFiles = walk(benchDir);

describe('bench files', () => {
  it('finds the recordings, tasks and results this scan is meant to cover', () => {
    expect(benchFiles.filter((p) => p.includes(join('bench', 'recordings'))).length).toBeGreaterThan(10);
    expect(benchFiles.filter((p) => p.includes(join('bench', 'tasks'))).length).toBeGreaterThan(5);
  });

  it.each(benchFiles.map((p) => [p.slice(benchDir.length), p]))('%s holds no credential', (_name, path) => {
    const text = readFileSync(path!, 'utf8');
    expect(text).not.toContain(FAKE_SECRET);
    for (const [label, pattern] of CREDENTIAL_PATTERNS) expect(pattern.test(text), label).toBe(false);
  });
});
