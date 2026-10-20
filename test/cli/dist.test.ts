import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

/** Packages (below node_modules) and bundle files a run loads, from the module-load tracer. */
function loads(args: string[]): { packages: string[]; files: string[] } {
  const trace = join(dir, 'trace.txt');
  rmSync(trace, { force: true });
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(join(root, 'scripts', 'lib', 'load-trace.mjs')).href, bin, ...args], {
    encoding: 'utf8',
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, NODE_DISABLE_COMPILE_CACHE: '1', VIA_TRACE_FILE: trace },
    timeout: 20_000,
  });
  expect(result.status).toBe(0);
  const urls = existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter((u) => u.startsWith('file://')) : [];
  const paths = urls.map((u) => fileURLToPath(u));
  const packages = new Set<string>();
  for (const path of paths) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path);
    if (m) packages.add(m[1]!);
  }
  return { packages: [...packages].sort(), files: paths.filter((p) => !p.includes('node_modules')).map((p) => p.slice(p.lastIndexOf('/') + 1)) };
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

  // Cold start is a core metric (implementation.md, "启动速度"): what a command does not need, it
  // must not load. These check the module graph, not the clock; `npm run bench:perf` times it.
  describe('lazy loading', () => {
    it('--version and -h load the entry and a text chunk only: no package, no command runner', () => {
      for (const args of [['--version'], ['-h']]) {
        const { packages, files } = loads(args);
        expect(packages).toEqual([]);
        expect(files.filter((f) => /^(run|app)-/.test(f))).toEqual([]);
        expect(files).toContain('via.js');
      }
    });

    it('a browse command with nothing configured loads neither the MCP SDK nor ajv', () => {
      for (const args of [[], ['find', 'issue']]) {
        const { packages, files } = loads(args);
        expect(files.some((f) => /^run-/.test(f))).toBe(true);
        expect(packages.filter((p) => p.startsWith('@modelcontextprotocol') || p.startsWith('ajv') || p === 'zod')).toEqual([]);
      }
    });
  });
});
