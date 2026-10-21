import { spawn, spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { featuresOf, FEATURES } from '../../scripts/lib/chunk-features';
import { CLI_STDIO_SERVER, FAKE_TOKEN, ghConfig, homeEnv, startFixtureServer } from './helpers';

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
    env: { ...homeEnv(home), NODE_DISABLE_COMPILE_CACHE: '1', VIA_NO_DAEMON: '1' },
    timeout: 20_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Like `via`, for commands that talk to a server running in this process. */
function viaAsync(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: home,
      env: { ...homeEnv(home), GH_TOKEN: FAKE_TOKEN, NODE_DISABLE_COMPILE_CACHE: '1', VIA_NO_DAEMON: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * VS Code's user-level `mcp.json` in this platform's directory: `%APPDATA%` is `<home>/.config` in
 * `homeEnv`, so Windows and Linux share the `.config` path.
 */
const vscodeUserConfig =
  process.platform === 'darwin' ? 'Library/Application Support/Code/User/mcp.json' : '.config/Code/User/mcp.json';

function writeUserConfig(yaml: string): void {
  mkdirSync(join(home, '.config', 'via'), { recursive: true });
  writeFileSync(join(home, '.config', 'via', 'config.yaml'), yaml);
}

/** Bundle files, the libraries inside them and node_modules packages a run loads, from the module-load tracer. */
function loads(args: string[]): { packages: string[]; files: string[]; libraries: string[] } {
  const trace = join(dir, 'trace.txt');
  rmSync(trace, { force: true });
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(join(root, 'scripts', 'lib', 'load-trace.mjs')).href, bin, ...args], {
    encoding: 'utf8',
    cwd: home,
    env: { ...homeEnv(home), NODE_DISABLE_COMPILE_CACHE: '1', VIA_NO_DAEMON: '1', VIA_TRACE_FILE: trace },
    timeout: 20_000,
  });
  expect(result.status).toBe(0);
  const urls = existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter((u) => u.startsWith('file://')) : [];
  const paths = urls.map((u) => fileURLToPath(u).replace(/\\/g, '/')); // the patterns below use '/'
  const packages = new Set<string>();
  for (const path of paths) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path);
    if (m) packages.add(m[1]!);
  }
  const bundle = paths.filter((p) => !p.includes('node_modules'));
  const libraries = new Set(bundle.flatMap((p) => featuresOf(readFileSync(p, 'utf8'))));
  return { packages: [...packages].sort(), files: bundle.map((p) => p.slice(p.lastIndexOf('/') + 1)), libraries: [...libraries].sort() };
}

/** The Node-internal modules a run loaded (`process.moduleLoadList`), from the preload in scripts/lib/builtin-trace.cjs. */
function internalModules(args: string[]): string[] {
  const trace = join(dir, 'builtins.txt');
  rmSync(trace, { force: true });
  const result = spawnSync(process.execPath, ['--require', join(root, 'scripts', 'lib', 'builtin-trace.cjs'), bin, ...args], {
    encoding: 'utf8',
    cwd: home,
    env: { ...homeEnv(home), GH_TOKEN: FAKE_TOKEN, NODE_DISABLE_COMPILE_CACHE: '1', VIA_NO_DAEMON: '1', VIA_BUILTIN_TRACE: trace },
    timeout: 20_000,
  });
  expect(result.status).toBe(0);
  return readFileSync(trace, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('NativeModule '))
    .map((l) => l.slice('NativeModule '.length));
}

beforeAll(() => {
  mkdirSync(join(root, '.build'), { recursive: true });
  dir = mkdtempSync(join(root, '.build', 'dist-'));
  // The fake home must not sit under a real one: framework discovery walks up from the working
  // directory, so a home inside the repo (and therefore inside the developer's home) would pick up
  // their own MCP configs as project-scope files.
  home = mkdtempSync(join(tmpdir(), 'via-dist-home-'));
  mkdirSync(home, { recursive: true });
  const out = join(dir, 'out');
  const build = spawnSync(process.execPath, [join(root, 'node_modules', 'tsup', 'dist', 'cli-default.js'), '--out-dir', out, '--silent'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  if (build.status !== 0) throw new Error(`tsup failed: ${build.stderr || build.stdout}`);
  bin = join(out, 'via.js');
}, 90_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (home) rmSync(home, { recursive: true, force: true });
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
    const batch = via(['batch']);
    expect(batch.code).toBe(2);
    expect(batch.stderr).toContain('error: no calls on stdin');
    expect(via(['-o', 'xml']).code).toBe(2);
  });

  // Whatever the build bundles or leaves external, the shipped file must still talk MCP: the SDK,
  // ajv (argument validation) and the stdio transport all load on demand from the built chunks.
  it('calls a tool over Streamable HTTP and over stdio', async () => {
    const srv = await startFixtureServer({ token: FAKE_TOKEN });
    try {
      writeUserConfig(`${ghConfig(srv.url)}  job:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(CLI_STDIO_SERVER)}]\n`);
      const http = await viaAsync(['gh', 'issue:read', '--owner', 'acme', '--repo', 'api', '--issue-number', '3', '--method', 'get']);
      expect(http).toMatchObject({ code: 0, stdout: 'number: 3\ntitle: Support OAuth DCR\nstate: open\n' });
      const invalid = await viaAsync(['gh', 'issue:read', '--owner', 'acme']);
      expect(invalid.code).toBe(2);
      const stdio = await viaAsync(['job', 'run_job']);
      expect(stdio).toMatchObject({ code: 0, stdout: 'job done\n' });
      expect(stdio.stderr).toContain('progress: 1/2 halfway');
    } finally {
      await srv.close();
      rmSync(join(home, '.config'), { recursive: true, force: true });
    }
  });

  // Bundled CommonJS packages lose their named exports when imported dynamically from a chunk, so
  // every format a config can be written in is read through the built file.
  it('reads configuration written as YAML, JSON, JSONC and TOML', () => {
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(home, path)), { recursive: true });
      writeFileSync(join(home, path), text);
    };
    write('.config/via/config.yaml', 'servers:\n  from-yaml:\n    url: http://127.0.0.1:9/mcp\n');
    write('.cursor/mcp.json', '{"mcpServers":{"from-json":{"url":"http://127.0.0.1:9/mcp"}}}');
    // VS Code keeps its user config in a per-platform directory (`data/frameworks/vscode.json`).
    write(vscodeUserConfig, '// comment\n{"servers":{"from-jsonc":{"type":"http","url":"http://127.0.0.1:9/mcp"},},}');
    write('.codex/config.toml', '[mcp_servers.from-toml]\nurl = "http://127.0.0.1:9/mcp"\n');
    try {
      const r = via(['servers']);
      expect(r.code).toBe(0);
      for (const name of ['from-yaml', 'from-json', 'from-jsonc', 'from-toml']) expect(r.stdout).toContain(name);
    } finally {
      for (const d of ['.config', '.cursor', '.codex', vscodeUserConfig.split('/').slice(0, -4).join('/')]) rmSync(join(home, d), { recursive: true, force: true });
    }
  });

  // Everything but the native keychain binding is bundled: the build must not import a package
  // from node_modules (each one is hundreds of files to resolve at startup, see bench:perf).
  it('bundles its dependencies and leaves only the native keychain binding external', () => {
    const external = new Set<string>();
    for (const file of readdirSync(dirname(bin)).filter((f) => f.endsWith('.js'))) {
      // Comments quote import examples; only code counts.
      const text = readFileSync(join(dirname(bin), file), 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
      for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\()\s*["']([@A-Za-z][\w@/.:-]*)["']/g)) external.add(m[1]!);
    }
    const builtin = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
    expect([...external].filter((spec) => !builtin.has(spec)).sort()).toEqual(['@napi-rs/keyring']);
  });

  // Evaluating string-width at load time (an Intl.Segmenter and a \p{RGI_Emoji} regex) cost ~30 ms
  // on every command that prints a table; the width code builds both on first non-ASCII text.
  it('does no Unicode setup at module level', () => {
    for (const file of readdirSync(dirname(bin)).filter((f) => f.endsWith('.js'))) {
      expect(readFileSync(join(dirname(bin), file), 'utf8')).not.toMatch(/^(?:var|let|const)\s+\w+\s*=\s*(?:new Intl\.Segmenter|\/[^\n]*RGI_Emoji)/m);
    }
  });

  // Cold start is a core metric (implementation.md, "启动速度"): what a command does not need, it
  // must not load. These check the module graph, not the clock; `npm run bench:perf` times it.
  describe('lazy loading', () => {
    it('the library markers still match the bundle (or the checks below would pass vacuously)', () => {
      const all = new Set(readdirSync(dirname(bin)).filter((f) => f.endsWith('.js')).flatMap((f) => featuresOf(readFileSync(join(dirname(bin), f), 'utf8'))));
      expect([...all].sort()).toEqual(FEATURES.map(([name]) => name).sort());
    });

    it('--version and -h load the entry and a text chunk only: no library, no command runner', () => {
      for (const args of [['--version'], ['-h']]) {
        const { packages, libraries, files } = loads(args);
        expect(packages).toEqual([]);
        expect(libraries).toEqual([]);
        expect(files.filter((f) => /^(run|app)-/.test(f))).toEqual([]);
        expect(files).toContain('via.js');
      }
    });

    // Each of these costs milliseconds to initialise and none is needed to print a table: `net` and
    // `tty` come with process.stdout / isatty, `crypto` with createHash, `internal/fs/promises` and
    // the stream classes with the ES module facade of `fs` (scripts/lib/lazy-builtins.ts).
    it('no command that prints a view initialises crypto, net, tty or the fs promises and stream classes', async () => {
      // A warm catalog: list once while the server is up, then browse from the disk cache.
      const srv = await startFixtureServer({ token: FAKE_TOKEN });
      try {
        writeUserConfig(ghConfig(srv.url));
        expect((await viaAsync(['sync'])).code).toBe(0);
      } finally {
        await srv.close();
      }
      try {
        const forbidden = ['crypto', 'net', 'tty', 'stream', 'fs/promises', 'internal/fs/promises', 'internal/fs/streams', 'readline', 'child_process'];
        for (const args of [['--version'], ['-h'], [], ['find', 'issue'], ['gh'], ['gh', 'issue'], ['servers']]) {
          expect(internalModules(args).filter((m) => forbidden.includes(m)), `via ${args.join(' ')}`).toEqual([]);
        }
      } finally {
        rmSync(join(home, '.config'), { recursive: true, force: true });
        rmSync(join(home, '.cache'), { recursive: true, force: true });
        rmSync(join(home, '.local'), { recursive: true, force: true }); // LOCALAPPDATA on Windows (homeEnv)
      }
    });

    // The browse commands name what they need in one module (src/cli/browse-deps.ts) so it is one
    // import, not six in a row; a command that never lists tools must not load any of it.
    it('`via daemon status` loads neither the catalog, the configuration nor the backends', () => {
      const { files } = loads(['daemon', 'status']);
      const dir = dirname(bin);
      for (const f of files) {
        const text = readFileSync(join(dir, f), 'utf8');
        expect(text, f).not.toMatch(/^\/\/ src\/(catalog\/|config\/(load|layer|merge|normalize|parse|credentials)\.ts)/m);
        expect(text, f).not.toMatch(/^\/\/ src\/cli\/(backend|view-cache|catalog-cache|directory)\.ts/m);
      }
    });

    // Making a `require` costs URL parsing and package.json lookups. Only chunks that mention
    // `require` (the esbuild runtime shim, CommonJS dependencies) get one; the rest do not
    // (scripts/lib/strip-require.ts).
    it('creates a require only in chunks that use one', () => {
      const all = readdirSync(dirname(bin)).filter((f) => f.endsWith('.js'));
      const withBanner = all.filter((f) => readFileSync(join(dirname(bin), f), 'utf8').includes('__viaCreateRequire'));
      expect(withBanner.length).toBeGreaterThan(0);
      expect(withBanner.length).toBeLessThan(all.length / 5);
      for (const f of all) {
        const text = readFileSync(join(dirname(bin), f), 'utf8');
        const rest = text.replace(/^#!.*\n/, '').replace("import { createRequire as __viaCreateRequire } from 'node:module';\nconst require = __viaCreateRequire(import.meta.url);\n", '');
        if (!withBanner.includes(f)) expect(rest, f).not.toMatch(/\brequire\b/);
      }
      for (const args of [[], ['find', 'x']]) {
        const { files } = loads(args);
        expect(files.filter((f) => withBanner.includes(f)).length, `via ${args.join(' ')}`).toBeLessThanOrEqual(2);
      }
      expect(readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    });

    it('a browse command with nothing configured loads neither the MCP SDK nor ajv', () => {
      for (const args of [[], ['find', 'issue']]) {
        const { libraries, files } = loads(args);
        expect(files.some((f) => /^run-/.test(f))).toBe(true);
        expect(libraries.filter((l) => ['mcp-sdk', 'zod', 'ajv'].includes(l))).toEqual([]);
      }
    });

    // Optional embedding retrieval (ADR 0011) is one chunk that only `find` with `search.semantic` imports.
    it('find without search.semantic never loads the embedding code', () => {
      const dir = dirname(bin);
      const semantic = readdirSync(dir).filter((f) => f.endsWith('.js') && readFileSync(join(dir, f), 'utf8').includes('VIAEMB1'));
      expect(semantic).toHaveLength(1);
      for (const args of [[], ['find', 'issue'], ['find', 'create a ticket']]) {
        expect(loads(args).files.filter((f) => semantic.includes(f))).toEqual([]);
      }
    });
  });
});
