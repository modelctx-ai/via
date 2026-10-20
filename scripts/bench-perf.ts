// Performance benchmark (testing.md, "性能目标"): CLI cold start, `find` over 1,000 tools,
// per-call overhead against a direct SDK client, and which modules each command loads. Run with
// `npm run bench:perf` after `npm run build`; it measures the built `dist/via.js`, in an isolated
// HOME with no real framework configs. Timings are reported against the targets, never asserted
// (CI is too noisy for that); the deterministic parts are covered by vitest.
//
//   --runs <n>     measured runs per row (default 30)     --warmup <n>  discarded runs (default 5)
//   --quick        10 runs, 2 warmups                      --skip-bun    do not measure Bun
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { arch, cpus, release, tmpdir, totalmem, type as osType } from 'node:os';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildCatalog, renderFind, SearchIndex } from '../src/catalog';
import { run } from '../src/cli/run';
import { createCliServer, createCliState, type CliState } from '../test/fixtures/mcp/cli-server.mjs';
import { loadBaseProviders, synthesizeProviders } from './lib/synth-catalog';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist', 'via.js');
const FIXTURES = join(ROOT, 'test', 'fixtures');
const TRACE_HOOK = join(ROOT, 'scripts', 'lib', 'load-trace.mjs');

// Targets from testing.md, "性能目标" (ms).
const TARGET_COLD_START = 80;
const TARGET_FIND_1000 = 30;
const TARGET_DAEMON_OVERHEAD = 15;

const FIND_QUERIES = ['create issue', 'send email message', 'github pull request merge', 'list files in directory', 'query database', 'take screenshot'];

// ---------------------------------------------------------------------------------------------
// options, statistics, tables

const argv = process.argv.slice(2);
function numberOption(name: string, fallback: number): number {
  const at = argv.indexOf(name);
  const n = at === -1 ? fallback : Number(argv[at + 1]);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} needs a positive integer`);
  return n;
}
const quick = argv.includes('--quick');
const RUNS = numberOption('--runs', quick ? 10 : 30);
const WARMUP = numberOption('--warmup', quick ? 2 : 5);

interface Stats {
  median: number;
  p95: number;
  min: number;
}

function stats(samples: readonly number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
  const mid = Math.floor(sorted.length / 2);
  return { median: sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2, p95: at(0.95), min: sorted[0]! };
}

const ms = (n: number): string => (n < 10 ? n.toFixed(2) : n.toFixed(1));
const verdict = (value: number, target: number): string => (value < target ? `ok (< ${target})` : `OVER (< ${target})`);

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(' | ')} |`;
  console.log(line(headers));
  console.log(`| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`);
  for (const r of rows) console.log(line(r));
  console.log('');
}

function section(title: string): void {
  console.log(`## ${title}\n`);
}

// ---------------------------------------------------------------------------------------------
// processes

interface Spawned {
  ms: number;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn to exit, timed around the child only. Output is captured so a failure can be reported. */
function spawnTimed(command: string, args: string[], options: SpawnOptions & { env: Record<string, string> }): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr!.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ ms: performance.now() - start, code, stdout, stderr }));
  });
}

/** Warmup runs, then `RUNS` measured ones; every run must exit with one of `okCodes`. */
async function measure(
  command: string,
  args: string[],
  options: SpawnOptions & { env: Record<string, string> },
  okCodes: readonly number[] = [0],
  envFor?: (run: number) => Record<string, string>,
): Promise<Stats> {
  const samples: number[] = [];
  for (let i = 0; i < WARMUP + RUNS; i += 1) {
    const r = await spawnTimed(command, args, envFor ? { ...options, env: envFor(i) } : options);
    if (r.code === null || !okCodes.includes(r.code)) {
      throw new Error(`${basename(command)} ${args.join(' ')} exited with ${String(r.code)}\n${r.stderr.slice(0, 600)}`);
    }
    if (i >= WARMUP) samples.push(r.ms);
  }
  return stats(samples);
}

// ---------------------------------------------------------------------------------------------
// fixtures: a sandbox (no real configs), mock MCP servers on localhost

interface Sandbox {
  root: string;
  home: string;
  project: string;
  /** TMPDIR of the child: Node's default compile-cache directory lives below it. */
  tmp: string;
  env: Record<string, string>;
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'via-bench-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const tmp = join(root, 'tmp');
  for (const d of [home, project, tmp]) mkdirSync(d, { recursive: true });
  return { root, home, project, tmp, env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: tmp } };
}

interface MockServer {
  url: string;
  state: CliState;
  close(): Promise<void>;
}

/** Stateless Streamable HTTP server over the CLI test fixture, serving the given tool list. */
async function startServer(tools?: unknown[]): Promise<MockServer> {
  const state = createCliState();
  if (tools) state.tools = tools as CliState['tools'];
  const http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        if (req.method !== 'POST') {
          res.writeHead(405).end();
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        const server = createCliServer({ state });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      })();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

/** Providers of the warm-catalog scenario: real `tools/list` snapshots, plus `gh` for calls. */
const SCENARIO_PROVIDERS = ['github', 'linear', 'notion', 'slack', 'gmail', 'filesystem', 'exa', 'postgres'];

function loadTools(provider: string): unknown[] {
  return (JSON.parse(readFileSync(join(FIXTURES, 'tools', `${provider}.json`), 'utf8')) as { tools: unknown[] }).tools;
}

function writeConfig(sb: Sandbox, servers: Array<{ name: string; url: string }>): void {
  const yaml = `sources: false\nservers:\n${servers.map((s) => `  ${s.name}:\n    url: ${s.url}\n`).join('')}`;
  mkdirSync(join(sb.home, '.config', 'via'), { recursive: true });
  writeFileSync(join(sb.home, '.config', 'via', 'config.yaml'), yaml);
}

/** Starts one fixture server per scenario provider and a sandbox whose config points at them. */
async function withLiveScenario<T>(fn: (sb: Sandbox) => Promise<T>): Promise<T> {
  const servers = await Promise.all(SCENARIO_PROVIDERS.map((p) => startServer(loadTools(p))));
  const sb = makeSandbox();
  try {
    writeConfig(sb, SCENARIO_PROVIDERS.map((name, i) => ({ name, url: servers[i]!.url })));
    return await fn(sb);
  } finally {
    await Promise.all(servers.map((s) => s.close()));
    rmSync(sb.root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// 1. cold start

interface Variant {
  label: string;
  env: (sb: Sandbox, run: number) => Record<string, string>;
}

const VARIANTS: Variant[] = [
  { label: 'no cache', env: (sb) => ({ ...sb.env, NODE_DISABLE_COMPILE_CACHE: '1' }) },
  // A fresh cache directory per run: the cost of the first run after install or upgrade.
  { label: 'cache cold', env: (sb, i) => ({ ...sb.env, TMPDIR: mkdtempSync(join(sb.tmp, `cold-${i}-`)) }) },
  // The shipped behaviour: `enableCompileCache()` on the non-trivial paths, warmed by the warmup runs.
  { label: 'cache warm', env: (sb) => sb.env },
];

const COLD_COMMANDS: Array<{ id: string; args: string[]; ok?: number[] }> = [
  { id: '--version', args: ['--version'] },
  { id: '-h', args: ['-h'] },
  { id: 'via (root)', args: [] },
  { id: 'via github', args: ['github'] },
  { id: 'via find', args: ['find', 'create issue'] },
];

// `via doctor` probes every server live (refresh), so it is measured against running servers.
const DOCTOR = { id: 'via doctor (live servers)', args: ['doctor'], ok: [0, 2, 4, 5, 6] };

async function benchColdStart(sb: Sandbox): Promise<Map<string, number>> {
  section('1. CLI cold start (spawn to exit)');
  const bare = await measure(process.execPath, ['-e', '0'], { env: sb.env, cwd: sb.project });
  const medians = new Map<string, number>();
  const rows: string[][] = [['node -e 0 (baseline)', '-', ms(bare.median), ms(bare.p95), ms(bare.min), '-', '-']];
  const compileCache = typeof (await import('node:module')).enableCompileCache === 'function';

  for (const cmd of COLD_COMMANDS) {
    for (const variant of VARIANTS) {
      const s = await measure(process.execPath, [DIST, ...cmd.args], { env: variant.env(sb, 0), cwd: sb.project }, cmd.ok, (i) => variant.env(sb, i));
      if (variant.label === 'cache warm') medians.set(cmd.id, s.median);
      rows.push([
        cmd.id,
        variant.label,
        ms(s.median),
        ms(s.p95),
        ms(s.min),
        ms(s.median - bare.median),
        variant.label === 'cache warm' ? verdict(s.median, TARGET_COLD_START) : '',
      ]);
    }
  }
  await withLiveScenario(async (live) => {
    for (const variant of VARIANTS) {
      const s = await measure(process.execPath, [DIST, ...DOCTOR.args], { env: variant.env(live, 0), cwd: live.project }, DOCTOR.ok, (i) => variant.env(live, i));
      rows.push([DOCTOR.id, variant.label, ms(s.median), ms(s.p95), ms(s.min), ms(s.median - bare.median), '']);
    }
  });
  // The entry file itself is not compiled through the cache on the trivial paths (it only enables
  // the cache after deciding it needs the command runner); NODE_COMPILE_CACHE covers it too.
  if (compileCache) {
    const dir = join(sb.tmp, 'env-cache');
    for (const cmd of COLD_COMMANDS.slice(0, 2)) {
      const env = { ...sb.env, NODE_COMPILE_CACHE: dir };
      const s = await measure(process.execPath, [DIST, ...cmd.args], { env, cwd: sb.project });
      rows.push([cmd.id, 'NODE_COMPILE_CACHE env', ms(s.median), ms(s.p95), ms(s.min), ms(s.median - bare.median), '']);
    }
  }
  printTable(['command', 'compile cache', 'median ms', 'p95 ms', 'min ms', 'median - bare', `target < ${TARGET_COLD_START} ms`], rows);
  if (!compileCache) console.log(`note: this Node (${process.version}) has no module.enableCompileCache(); the cache rows are the same as "no cache".\n`);
  console.log(`runs: ${RUNS} measured, ${WARMUP} warmup; "cache warm" uses the default cache directory under the sandbox TMPDIR.\n`);
  return medians;
}

// ---------------------------------------------------------------------------------------------
// 2. find over 1,000 tools

interface FindChild {
  tools: number;
  cold: { build: number; index: number; query: number; render: number };
  steady: { build: number; index: number; query: number };
}

/** Runs in a fresh process: first-call timings (what a one-shot CLI pays), then steady state. */
function findChild(): FindChild {
  const providers = synthesizeProviders(loadBaseProviders(FIXTURES));
  const time = <T>(f: () => T): [T, number] => {
    const t = performance.now();
    const v = f();
    return [v, performance.now() - t];
  };
  const [catalog, build] = time(() => buildCatalog(providers));
  const [index, indexMs] = time(() => new SearchIndex(catalog));
  const [hits, query] = time(() => index.search(FIND_QUERIES[0]!, { limit: 10 }));
  const [, render] = time(() => renderFind(hits, FIND_QUERIES[0]!));

  const median = (xs: number[]) => stats(xs).median;
  const builds: number[] = [];
  const indexes: number[] = [];
  const queries: number[] = [];
  for (let i = 0; i < 15; i += 1) {
    const [c, b] = time(() => buildCatalog(providers));
    builds.push(b);
    const [x, ix] = time(() => new SearchIndex(c));
    indexes.push(ix);
    for (const q of FIND_QUERIES) queries.push(time(() => x.search(q, { limit: 10 }))[1]);
  }
  return {
    tools: index.size,
    cold: { build, index: indexMs, query, render },
    steady: { build: median(builds), index: median(indexes), query: median(queries) },
  };
}

async function benchFind(sb: Sandbox): Promise<void> {
  section('2. `find` over 1,000 tools (in-process, real catalog APIs)');
  const children: FindChild[] = [];
  for (let i = 0; i < WARMUP + Math.max(RUNS / 2, 8); i += 1) {
    const r = await spawnTimed(process.execPath, [process.argv[1]!, '--child-find'], { env: sb.env, cwd: ROOT });
    if (r.code !== 0) throw new Error(`find child failed: ${r.stderr}`);
    if (i >= WARMUP) children.push(JSON.parse(r.stdout) as FindChild);
  }
  const tools = children[0]!.tools;
  const pick = (f: (c: FindChild) => number) => stats(children.map(f));
  const row = (label: string, s: Stats, target = ''): string[] => [label, ms(s.median), ms(s.p95), ms(s.min), target];
  const coldTotal = pick((c) => c.cold.build + c.cold.index + c.cold.query);
  const steadyQuery = pick((c) => c.steady.query);
  printTable(
    ['phase', 'median ms', 'p95 ms', 'min ms', `target < ${TARGET_FIND_1000} ms`],
    [
      row('catalog build (split, domains), first call', pick((c) => c.cold.build)),
      row('index build, first call', pick((c) => c.cold.index)),
      row('query, first call', pick((c) => c.cold.query)),
      row('render hits, first call', pick((c) => c.cold.render)),
      row('build + index + first query (one-shot CLI)', coldTotal, verdict(coldTotal.median, TARGET_FIND_1000)),
      row('catalog build, steady state', pick((c) => c.steady.build)),
      row('index build, steady state', pick((c) => c.steady.index)),
      row('query, steady state', steadyQuery, verdict(steadyQuery.median, TARGET_FIND_1000)),
    ],
  );
  console.log(`catalog: ${tools} tools, ${50} providers (deterministic, seed 1); ${children.length} fresh processes, "first call" is the first use in each; steady state is the median of 15 rounds x ${FIND_QUERIES.length} queries.\n`);
}

// ---------------------------------------------------------------------------------------------
// 3. call overhead

async function benchCall(): Promise<void> {
  section('3. per-call overhead against a local Streamable HTTP server (0.1: no daemon)');
  const server = await startServer();
  const sb = makeSandbox();
  try {
    writeConfig(sb, [{ name: 'gh', url: server.url }]);
    const callArgs = ['gh', 'echo_text', '--message', 'hi'];
    const env = { ...sb.env };

    const direct = async (): Promise<void> => {
      const client = new Client({ name: 'bench', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
      await client.callTool({ name: 'echo_text', arguments: { message: 'hi' } });
      await client.close();
    };
    const viaRun = async (): Promise<void> => {
      let out = '';
      const code = await run(callArgs, {
        env,
        cwd: sb.project,
        home: sb.home,
        platform: process.platform,
        stdout: { write: (s: string) => void (out += s) },
        stderr: { write: () => undefined },
        readStdin: async () => '',
      });
      if (code !== 0 || !out.includes('echo: hi')) throw new Error(`via call failed (${code}): ${out}`);
    };
    const timeAsync = async (f: () => Promise<void>): Promise<Stats> => {
      const samples: number[] = [];
      for (let i = 0; i < WARMUP + RUNS; i += 1) {
        const t = performance.now();
        await f();
        if (i >= WARMUP) samples.push(performance.now() - t);
      }
      return stats(samples);
    };

    // A reused connection is the floor a daemon could reach: one request, no handshake.
    const reuse = new Client({ name: 'bench', version: '0.0.0' });
    await reuse.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    const reused = await timeAsync(async () => void (await reuse.callTool({ name: 'echo_text', arguments: { message: 'hi' } })));
    await reuse.close();

    await viaRun(); // fills the catalog cache so the measured runs are warm
    const directStats = await timeAsync(direct);
    const viaStats = await timeAsync(viaRun);

    // Process level: what a 0.1 invocation costs, including the interpreter and the module graph.
    const sdkScript = join(ROOT, '.build', 'bench-perf', 'sdk-call.mjs');
    mkdirSync(join(ROOT, '.build', 'bench-perf'), { recursive: true });
    writeFileSync(
      sdkScript,
      `import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client = new Client({ name: 'bench', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(process.argv[2])));
await client.callTool({ name: 'echo_text', arguments: { message: 'hi' } });
await client.close();
`,
    );
    const procEnv = { ...sb.env };
    const bare = await measure(process.execPath, ['-e', '0'], { env: procEnv, cwd: sb.project });
    // NODE_COMPILE_CACHE gives the SDK-only script what via gets from enableCompileCache().
    const sdkProc = await measure(process.execPath, [sdkScript, server.url], { env: { ...procEnv, NODE_COMPILE_CACHE: join(sb.tmp, 'sdk-cache') }, cwd: ROOT });
    const viaProc = await measure(process.execPath, [DIST, ...callArgs], { env: procEnv, cwd: sb.project });

    const row = (label: string, s: Stats, extra = ''): string[] => [label, ms(s.median), ms(s.p95), ms(s.min), extra];
    printTable(
      ['scenario', 'median ms', 'p95 ms', 'min ms', 'notes'],
      [
        row('in-process: SDK callTool, reused connection', reused, 'floor: one HTTP request'),
        row('in-process: SDK connect + callTool + close', directStats, 'fresh connection, like one CLI call'),
        row('in-process: run([gh echo_text ...])', viaStats, 'config + cache + resolve + validate + connect + call + render'),
        row('  via adds over fresh SDK call', { median: viaStats.median - directStats.median, p95: viaStats.p95 - directStats.p95, min: viaStats.min - directStats.min }, `daemon target < ${TARGET_DAEMON_OVERHEAD} ms is 0.2, reference only`),
        row('process: node -e 0', bare),
        row('process: node sdk-call.mjs (SDK only)', sdkProc),
        row('process: node dist/via.js gh echo_text', viaProc),
        row('  via adds over SDK-only process', { median: viaProc.median - sdkProc.median, p95: viaProc.p95 - sdkProc.p95, min: viaProc.min - sdkProc.min }),
      ],
    );
    console.log('in-process rows run src/cli/run in this process with warm JIT; process rows spawn the built CLI. Differences of p95 / min are of the two columns, not paired.\n');
  } finally {
    await server.close();
    rmSync(sb.root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// 4. module loading

const FORBIDDEN_ON_TRIVIAL = /^(?:@modelcontextprotocol\/sdk|ajv|ajv-formats|yaml|smol-toml|jsonc-parser|@napi-rs\/keyring|string-width)$/;

interface Loaded {
  chunks: number;
  kib: number;
  packages: string[];
}

function summarizeTrace(trace: string): Loaded {
  const urls = trace.split('\n').filter(Boolean);
  let kib = 0;
  const chunks = new Set<string>();
  const packages = new Set<string>();
  for (const url of urls) {
    if (!url.startsWith('file://')) continue;
    const path = fileURLToPath(url);
    const nm = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path);
    if (nm) packages.add(nm[1]!);
    else if (path.startsWith(join(ROOT, 'dist'))) {
      chunks.add(path);
      kib += statSync(path).size / 1024;
    }
  }
  return { chunks: chunks.size, kib, packages: [...packages].sort() };
}

async function traceLoads(sb: Sandbox, args: string[]): Promise<Loaded> {
  const file = join(sb.root, 'trace.txt');
  rmSync(file, { force: true });
  const r = await spawnTimed(process.execPath, ['--import', TRACE_HOOK, DIST, ...args], {
    env: { ...sb.env, NODE_DISABLE_COMPILE_CACHE: '1', VIA_TRACE_FILE: file },
    cwd: sb.project,
  });
  if (r.code === null || r.code > 6) throw new Error(`traced run failed: ${r.stderr}`);
  return summarizeTrace(existsSync(file) ? readFileSync(file, 'utf8') : '');
}

async function benchLoads(sb: Sandbox): Promise<boolean> {
  section('4. modules loaded per command (bundle chunks and node_modules packages)');
  const browse: Array<{ id: string; args: string[]; trivial: boolean }> = [
    { id: '--version', args: ['--version'], trivial: true },
    { id: '-h', args: ['-h'], trivial: true },
    ...COLD_COMMANDS.slice(2).map((c) => ({ id: c.id, args: c.args, trivial: false })),
  ];
  let ok = true;
  const rows: string[][] = [];
  const add = (id: string, loaded: Loaded, trivial: boolean, mayLoadClient: boolean): void => {
    let status = 'ok';
    if (trivial && loaded.packages.length > 0) status = 'FAIL: loads packages';
    else if (!mayLoadClient && loaded.packages.some((p) => p.startsWith('@modelcontextprotocol') || p.startsWith('ajv'))) status = 'FAIL: MCP SDK or ajv on a cached browse';
    if (status !== 'ok') ok = false;
    rows.push([id, String(loaded.chunks), loaded.kib.toFixed(0), loaded.packages.join(', ') || '(none)', loaded.packages.some((p) => FORBIDDEN_ON_TRIVIAL.test(p)) ? 'yes' : 'no', status]);
  };
  for (const c of browse) add(c.id, await traceLoads(sb, c.args), c.trivial, false);

  await withLiveScenario(async (live) => add(DOCTOR.id, await traceLoads(live, DOCTOR.args), false, true));

  // A call needs a live server; the sandbox's catalog cache is filled by a first call.
  const server = await startServer();
  const callSb = makeSandbox();
  try {
    writeConfig(callSb, [{ name: 'gh', url: server.url }]);
    const args = ['gh', 'echo_text', '--message', 'hi'];
    await spawnTimed(process.execPath, [DIST, ...args], { env: callSb.env, cwd: callSb.project });
    add('via gh echo_text', await traceLoads(callSb, args), false, true);
  } finally {
    await server.close();
    rmSync(callSb.root, { recursive: true, force: true });
  }
  printTable(['command', 'bundle chunks', 'KiB', 'node_modules packages', 'heavy deps', 'check'], rows);
  console.log('check: --version and -h load no package at all; cached browse commands (root, provider, find) load neither the MCP SDK nor ajv. "heavy deps": SDK, ajv, config parsers, keyring or string-width. Only ESM imports are seen, not `require` calls made inside a CommonJS package.\n');
  return ok;
}

// ---------------------------------------------------------------------------------------------
// 5. Bun

async function benchBun(sb: Sandbox): Promise<void> {
  section('5. Bun single-file binary (open question: runtime and distribution)');
  const probe = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0 || argv.includes('--skip-bun')) {
    console.log(argv.includes('--skip-bun') ? 'skipped (--skip-bun).\n' : 'skipped: `bun` is not installed (install it from https://bun.sh to fill this section in).\n');
    return;
  }
  const outDir = join(ROOT, '.build', 'bench-perf');
  mkdirSync(outDir, { recursive: true });
  const binary = join(outDir, 'via-bun');
  const compile = spawnSync('bun', ['build', 'src/cli/main.ts', '--compile', '--outfile', binary], { cwd: ROOT, encoding: 'utf8' });
  if (compile.status !== 0 || !existsSync(binary)) {
    console.log(`skipped: \`bun build --compile\` failed:\n${(compile.stderr || compile.stdout).slice(0, 600)}\n`);
    return;
  }
  const size = statSync(binary).size / (1024 * 1024);
  // Same warm-catalog scenario as section 1: the binary reads the cache written by the Node run.
  const rows: string[][] = [];
  const bareNode = await measure(process.execPath, ['-e', '0'], { env: sb.env, cwd: sb.project });
  const bareBun = await measure('bun', ['-e', '0'], { env: sb.env, cwd: sb.project });
  rows.push(['(baseline) node -e 0', ms(bareNode.median), ms(bareNode.p95), ms(bareNode.min)]);
  rows.push(['(baseline) bun -e 0', ms(bareBun.median), ms(bareBun.p95), ms(bareBun.min)]);
  for (const cmd of [COLD_COMMANDS[0]!, COLD_COMMANDS[1]!, COLD_COMMANDS[2]!, COLD_COMMANDS[4]!]) {
    const node = await measure(process.execPath, [DIST, ...cmd.args], { env: sb.env, cwd: sb.project }, cmd.ok);
    const bunRun = await measure('bun', [DIST, ...cmd.args], { env: sb.env, cwd: sb.project }, cmd.ok);
    const compiled = await measure(binary, cmd.args, { env: sb.env, cwd: sb.project }, cmd.ok);
    rows.push([`${cmd.id}: node dist/via.js (cache warm)`, ms(node.median), ms(node.p95), ms(node.min)]);
    rows.push([`${cmd.id}: bun dist/via.js`, ms(bunRun.median), ms(bunRun.p95), ms(bunRun.min)]);
    rows.push([`${cmd.id}: bun --compile binary`, ms(compiled.median), ms(compiled.p95), ms(compiled.min)]);
  }
  printTable(['scenario', 'median ms', 'p95 ms', 'min ms'], rows);
  console.log(`bun ${probe.stdout.trim()}; compiled binary ${size.toFixed(0)} MiB. The Node rows use the sandbox compile cache; Bun has no equivalent switch.\n`);
}

// ---------------------------------------------------------------------------------------------

function environmentLines(): string[] {
  const c = cpus();
  const bun = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  return [
    `date: ${new Date().toISOString().slice(0, 10)}`,
    `cpu: ${c[0]?.model ?? 'unknown'} x ${c.length}`,
    `memory: ${(totalmem() / 1024 ** 3).toFixed(1)} GiB`,
    `os: ${osType()} ${release()} ${arch()}`,
    `node: ${process.version}`,
    `bun: ${bun.status === 0 ? bun.stdout.trim() : 'not installed'}`,
    `runs: ${RUNS} measured + ${WARMUP} warmup per row`,
  ];
}

async function main(): Promise<void> {
  if (argv.includes('--child-find')) {
    process.stdout.write(`${JSON.stringify(findChild())}\n`);
    return;
  }
  if (!existsSync(DIST) || !existsSync(TRACE_HOOK)) {
    console.error(`error: ${existsSync(DIST) ? TRACE_HOOK : DIST} not found; run \`npm run build\` first, from the repository root.`);
    process.exitCode = 1;
    return;
  }

  console.log('# via performance benchmark\n');
  for (const l of environmentLines()) console.log(`- ${l}`);
  console.log('');

  const sb = makeSandbox();
  let healthy = true;
  try {
    // Warm-catalog scenario shared by sections 1 and 5: real fixtures, cached on disk, servers gone.
    const servers = await Promise.all(SCENARIO_PROVIDERS.map((p) => startServer(loadTools(p))));
    try {
      writeConfig(sb, SCENARIO_PROVIDERS.map((name, i) => ({ name, url: servers[i]!.url })));
      const prime = await spawnTimed(process.execPath, [DIST, 'sync'], { env: sb.env, cwd: sb.project });
      if (prime.code !== 0) throw new Error(`sync failed (${prime.code}): ${prime.stderr}`);
    } finally {
      await Promise.all(servers.map((s) => s.close()));
    }
    const root = await spawnTimed(process.execPath, [DIST], { env: sb.env, cwd: sb.project });
    console.log(`scenario: ${SCENARIO_PROVIDERS.length} providers from test/fixtures/tools, tools/list cached on disk (${root.stdout.split('\n').find((l) => /providers/.test(l)) ?? 'root view'}), servers stopped; HOME and TMPDIR are in ${sb.root}.\n`);

    const cold = await benchColdStart(sb);
    await benchFind(sb);
    await benchCall();
    healthy = (await benchLoads(sb)) && healthy;
    await benchBun(sb);

    section('Summary against the targets');
    printTable(
      ['target', 'measured', 'result'],
      [
        ['CLI cold start < 80 ms: --version (cache warm)', `${ms(cold.get('--version') ?? NaN)} ms`, verdict(cold.get('--version') ?? Infinity, TARGET_COLD_START)],
        ['CLI cold start < 80 ms: via (root, warm catalog)', `${ms(cold.get('via (root)') ?? NaN)} ms`, verdict(cold.get('via (root)') ?? Infinity, TARGET_COLD_START)],
        ['hot daemon overhead < 15 ms', 'n/a', '0.2 (no daemon in 0.1)'],
        ['daemon memory < 80 MB', 'n/a', '0.2 (no daemon in 0.1)'],
      ],
    );
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
  process.exitCode = healthy ? 0 : 1;
}

await main();
