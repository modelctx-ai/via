import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The shipped CLI is what users run: build it exactly as `npm run build` does (into a scratch
// directory inside the repo, so its external dependencies still resolve) and run the real binary.
const root = fileURLToPath(new URL('../..', import.meta.url));
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;

let dir = '';
let home = '';
let bin = '';

function via(args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, NODE_DISABLE_COMPILE_CACHE: '1' },
    timeout: 20_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  mkdirSync(join(root, '.build'), { recursive: true });
  dir = mkdtempSync(join(root, '.build', 'dist-'));
  home = join(dir, 'home');
  mkdirSync(home);
  const out = join(dir, 'out');
  const build = spawnSync(join(root, 'node_modules', '.bin', 'tsup'), ['--out-dir', out, '--silent'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  if (build.status !== 0) throw new Error(`tsup failed: ${build.stderr || build.stdout}`);
  bin = join(out, 'via.js');
}, 90_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('built dist/via.js', () => {
  it('prints the version', () => {
    expect(via(['--version'])).toEqual({ code: 0, stdout: `${version}\n`, stderr: '' });
  });

  it('prints help', () => {
    const r = via(['-h']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('usage:');
  });

  it('runs `via` with an empty configuration (command runner, config and catalog chunks load)', () => {
    const r = via([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('0 providers · 0 tools');
    expect(r.stderr).toBe('');
  });

  it('reports errors with exit codes', () => {
    const r = via(['nothing-here']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('error: no such provider: nothing-here');
    expect(via(['more', 'ffff']).code).toBe(3);
    expect(via(['batch']).code).toBe(2);
    expect(via(['-o', 'xml']).code).toBe(2);
  });
});
