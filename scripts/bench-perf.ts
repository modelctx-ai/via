// Performance benchmark (testing.md, "性能目标"): CLI cold start (as milliseconds over a bare
// `node -e 0` measured alternately in the same run), `find` over 1,000 tools, per-call overhead
// against a direct SDK client, daemon memory (RssAnon on Linux), and which modules each command loads. Run with
// `npm run bench:perf` after `npm run build`; it measures the built `dist/via.js`, in an isolated
// HOME with no real framework configs. Timings are reported against the targets, never asserted
// (CI is too noisy for that); the deterministic parts are covered by vitest.
//
//   --runs <n>     measured runs per row (default 30)     --warmup <n>  discarded runs (default 5)
//   --quick        10 runs, 2 warmups
//   --only <list>  run only some sections (cold,scenarios,find,call,loads,daemon)
//   --compare <dir> a second build (say, from the previous commit) to run next to --dist/dist in the
//                   scenarios section, alternating runs so both see the same machine load
//   --dist <dir>   measure this build instead of dist/ (relative to the repository root)
//   --plain-daemon start the section-5 daemon without the V8 and malloc settings of daemonRuntime (for a --dist build older than them)
import { spawn, type SpawnOptions } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { arch, cpus, loadavg, release, tmpdir, totalmem, type as osType } from 'node:os';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildCatalog, normalizeProviderName, renderFind, restoreProvider, SearchIndex, snapshotProvider, type CatalogTool, type DocTerms, type RestoredTerms } from '../src/catalog';
import { CatalogCache } from '../src/cli/catalog-cache';
import { run } from '../src/cli/run';
import { loadConfig } from '../src/config';
import { daemonRuntime } from '../src/daemon/client';
import { createCliServer, createCliState, type CliState } from '../test/fixtures/mcp/cli-server.mjs';
import { featuresOf } from './lib/chunk-features';
import { loadBaseProviders, synthesizeProviders } from './lib/synth-catalog';

const ROOT = process.cwd();
// `--dist <dir>` measures another build (say, one from before a change) with the same scenario.
const distOption = process.argv.indexOf('--dist');
const DIST_DIR = distOption === -1 ? join(ROOT, 'dist') : join(ROOT, process.argv[distOption + 1] ?? '');
const DIST = join(DIST_DIR, 'via.js');
const FIXTURES = join(ROOT, 'test', 'fixtures');
const TRACE_HOOK = join(ROOT, 'scripts', 'lib', 'load-trace.mjs');
const BUILTIN_TRACE = join(ROOT, 'scripts', 'lib', 'builtin-trace.cjs');

// Targets from testing.md, "性能目标". Start-up targets are relative: milliseconds over `node -e 0`,
// measured alternately with the command so both see the same machine load.
const TARGET_COLD_OVER_NODE = 50; // via, via <provider>, via find; at most
const TARGET_DAEMON_OVER_NODE = 70; // via, via find through a warm daemon; less than
const TARGET_FRAMEWORK_OVER_NODE = 80; // via, via find with framework config files; less than
const TARGET_FIND_PROCESS_OVER_NODE = 80; // whole-process via find over 1,000 tools; at most
const TARGET_FIND_1000 = 30; // ms, the library path (prebuilt cache, fresh process)
const TARGET_DAEMON_OVERHEAD = 15; // ms, absolute
const TARGET_DAEMON_ANON_MIB = 55; // RssAnon, Linux: the highest seen over repeated runs is 49.5 (testing.md has the reasoning)
const TARGET_DAEMON_RSS_MIB = 105; // RSS, where /proc/<pid>/status does not exist (labelled as such): the RssAnon target plus the node binary's ~49 MiB of file pages

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
// `--only cold,find` runs just those sections: cold, scenarios, find, call, loads, daemon (default: all).
const onlyOption = argv.indexOf('--only');
const ONLY = onlyOption === -1 ? undefined : new Set((argv[onlyOption + 1] ?? '').split(','));
const wanted = (section: string): boolean => ONLY === undefined || ONLY.has(section);
const compareOption = argv.indexOf('--compare');
const COMPARE_DIST = compareOption === -1 ? undefined : join(ROOT, argv[compareOption + 1] ?? '');
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
/** "At most N" targets (the +50 ms and +80 ms over bare node). */
const verdictAtMost = (value: number, target: number): string => (value <= target ? `ok (<= ${target})` : `OVER (<= ${target})`);
const signed = (n: number): string => `${n < 0 ? '-' : '+'}${ms(Math.abs(n))}`;

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

interface Contender {
  label: string;
  command: string;
  args: string[];
  env: (run: number) => Record<string, string>;
}

/** Runs of several commands, alternating, so a change in machine load hits all of them alike. */
async function measureAlternating(contenders: readonly Contender[], cwd: string, okCodes: readonly number[] = [0]): Promise<Map<string, Stats>> {
  const samples = new Map(contenders.map((c) => [c.label, [] as number[]]));
  for (let i = 0; i < WARMUP + RUNS; i += 1) {
    for (const c of contenders) {
      const r = await spawnTimed(c.command, c.args, { env: c.env(i), cwd });
      if (r.code === null || !okCodes.includes(r.code)) throw new Error(`${c.label}: ${basename(c.command)} ${c.args.join(' ')} exited with ${String(r.code)}\n${r.stderr.slice(0, 600)}`);
      if (i >= WARMUP) samples.get(c.label)!.push(r.ms);
    }
  }
  return new Map([...samples].map(([label, xs]) => [label, stats(xs)]));
}

/** A command measured next to `node -e 0` (alternating): `delta` is the milliseconds the command adds to a bare node. */
interface Paired {
  stats: Stats;
  bare: Stats;
  delta: number;
}

async function measurePaired(sb: Sandbox, args: string[], env: (run: number) => Record<string, string>, okCodes?: readonly number[]): Promise<Paired> {
  const bareEnv = (): Record<string, string> => sb.env;
  const measured = await measureAlternating(
    [
      { label: 'bare', command: process.execPath, args: ['-e', '0'], env: bareEnv },
      { label: 'command', command: process.execPath, args, env },
    ],
    sb.project,
    okCodes,
  );
  const stats = measured.get('command')!;
  const bare = measured.get('bare')!;
  return { stats, bare, delta: stats.median - bare.median };
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
  const root = mkdtempSync(join(tmpdir(), 'via-perf-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const tmp = join(root, 'tmp');
  for (const d of [home, project, tmp]) mkdirSync(d, { recursive: true });
  return { root, home, project, tmp, env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: tmp, VIA_NO_DAEMON: '1' } };
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

function writeConfig(sb: Sandbox, servers: Array<{ name: string; url: string }>, extraYaml = ''): void {
  const yaml = `sources: false\n${extraYaml}servers:\n${servers.map((s) => `  ${s.name}:\n    url: ${s.url}\n`).join('')}`;
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

// `browse`: the commands the cold-start target (at most +50 ms over bare node) applies to.
const COLD_COMMANDS: Array<{ id: string; args: string[]; ok?: number[]; browse?: boolean }> = [
  { id: '--version', args: ['--version'] },
  { id: '-h', args: ['-h'] },
  { id: 'via (root)', args: [], browse: true },
  { id: 'via github', args: ['github'], browse: true },
  { id: 'via find', args: ['find', 'create issue'], browse: true },
];

// `via doctor` probes every server live (refresh), so it is measured against running servers.
const DOCTOR = { id: 'via doctor (live servers)', args: ['doctor'], ok: [0, 2, 4, 5, 6] };

async function benchColdStart(sb: Sandbox): Promise<Map<string, Paired>> {
  section('1. CLI cold start (spawn to exit; each row alternates with node -e 0)');
  const bare = await measure(process.execPath, ['-e', '0'], { env: sb.env, cwd: sb.project });
  const results = new Map<string, Paired>();
  const rows: string[][] = [['node -e 0 (baseline)', '-', ms(bare.median), ms(bare.p95), ms(bare.min), '-', '-', '']];
  const compileCache = typeof (await import('node:module')).enableCompileCache === 'function';

  for (const cmd of COLD_COMMANDS) {
    for (const variant of VARIANTS) {
      const p = await measurePaired(sb, [DIST, ...cmd.args], (i) => variant.env(sb, i), cmd.ok);
      const warm = variant.label === 'cache warm';
      if (warm) results.set(cmd.id, p);
      rows.push([
        cmd.id,
        variant.label,
        ms(p.stats.median),
        ms(p.stats.p95),
        ms(p.stats.min),
        ms(p.bare.median),
        signed(p.delta),
        warm && cmd.browse ? verdictAtMost(p.delta, TARGET_COLD_OVER_NODE) : '',
      ]);
    }
  }
  await withLiveScenario(async (live) => {
    for (const variant of VARIANTS) {
      const p = await measurePaired(live, [DIST, ...DOCTOR.args], (i) => variant.env(live, i), DOCTOR.ok);
      rows.push([DOCTOR.id, variant.label, ms(p.stats.median), ms(p.stats.p95), ms(p.stats.min), ms(p.bare.median), signed(p.delta), '']);
    }
  });
  // The entry file itself is not compiled through the cache on the trivial paths (it only enables
  // the cache after deciding it needs the command runner); NODE_COMPILE_CACHE covers it too.
  if (compileCache) {
    const dir = join(sb.tmp, 'env-cache');
    for (const cmd of COLD_COMMANDS.slice(0, 2)) {
      const p = await measurePaired(sb, [DIST, ...cmd.args], () => ({ ...sb.env, NODE_COMPILE_CACHE: dir }));
      rows.push([cmd.id, 'NODE_COMPILE_CACHE env', ms(p.stats.median), ms(p.stats.p95), ms(p.stats.min), ms(p.bare.median), signed(p.delta), '']);
    }
  }
  printTable(['command', 'compile cache', 'median ms', 'p95 ms', 'min ms', 'node -e 0 (paired) ms', 'over node -e 0 ms', `target: at most +${TARGET_COLD_OVER_NODE} ms`], rows);
  if (!compileCache) console.log(`note: this Node (${process.version}) has no module.enableCompileCache(); the cache rows are the same as "no cache".\n`);
  console.log(`runs: ${RUNS} measured, ${WARMUP} warmup; "cache warm" uses the default cache directory under the sandbox TMPDIR. The first row is a separate measurement; every other row alternates its command with \`node -e 0\` and subtracts the medians of the two, so a machine that is slow right now is slow for both. The target applies to the "cache warm" rows of via, via github and via find.\n`);
  return results;
}

// ---------------------------------------------------------------------------------------------
// 1b. scenarios nearer to real use: framework configs, 1,000 tools, a warm daemon

/** `~/.claude.json`-shaped file: a few servers among the history of many projects (this is most of its size). */
function bulkClaudeJson(servers: Record<string, unknown>): string {
  const projects: Record<string, unknown> = {};
  for (let i = 0; i < 300; i += 1) {
    projects[`/home/user/work/project-${i}`] = {
      allowedTools: [],
      history: [{ display: `an earlier prompt, number ${i}, long enough to matter for parse time`, pastedContents: {} }],
      mcpServers: {},
      enabledMcpjsonServers: [],
      lastCost: 0.5,
      lastDuration: 1234 + i,
    };
  }
  return JSON.stringify({ numStartups: 120, installMethod: 'native', mcpServers: servers, projects });
}

interface ScenarioSandbox {
  sb: Sandbox;
  describe: string;
}

/** The 8 scenario providers plus servers from four framework configs, every list cached, servers gone. */
async function makeFrameworkScenario(): Promise<ScenarioSandbox> {
  const servers = await Promise.all(SCENARIO_PROVIDERS.map((p) => startServer(loadTools(p))));
  const sb = makeSandbox();
  try {
    const user = SCENARIO_PROVIDERS.map((name, i) => `  ${name}:\n    url: ${servers[i]!.url}\n`).join('');
    mkdirSync(join(sb.home, '.config', 'via'), { recursive: true });
    writeFileSync(join(sb.home, '.config', 'via', 'config.yaml'), `servers:\n${user}`);
    const put = (path: string, text: string): void => {
      mkdirSync(join(sb.home, path, '..'), { recursive: true });
      writeFileSync(join(sb.home, path), text);
    };
    put('.claude.json', bulkClaudeJson({ 'fw-claude': { type: 'http', url: servers[0]!.url } }));
    put('.cursor/mcp.json', JSON.stringify({ mcpServers: { 'fw-cursor': { url: servers[1]!.url } } }));
    put('.codex/config.toml', `[mcp_servers.fw-codex]\nurl = "${servers[2]!.url}"\n`);
    put('.config/Code/User/mcp.json', `// VS Code\n{\n  "servers": { "fw-vscode": { "type": "http", "url": "${servers[3]!.url}" } }\n}\n`);
    const prime = await spawnTimed(process.execPath, [DIST, 'sync'], { env: sb.env, cwd: sb.project });
    if (prime.code !== 0) throw new Error(`sync failed (${prime.code}): ${prime.stderr}`);
    const root = await spawnTimed(process.execPath, [DIST], { env: sb.env, cwd: sb.project });
    return { sb, describe: `${root.stdout.split('\n')[0] ?? ''}, 4 framework config files (a ${(bulkClaudeJson({}).length / 1024).toFixed(0)} KiB .claude.json among them)` };
  } finally {
    await Promise.all(servers.map((s) => s.close()));
  }
}

/** 50 providers / 1,000 tools (the synthetic catalog of section 2), written straight into the disk cache. */
async function makeScaleScenario(): Promise<ScenarioSandbox> {
  const providers = synthesizeProviders(loadBaseProviders(FIXTURES));
  const sb = makeSandbox();
  mkdirSync(join(sb.home, '.config', 'via'), { recursive: true });
  writeFileSync(join(sb.home, '.config', 'via', 'config.yaml'), `sources: false\nservers:\n${providers.map((p) => `  ${p.provider}:\n    url: http://127.0.0.1:1/${p.provider}\n`).join('')}`);
  const config = await loadConfig({ home: sb.home, cwd: sb.project, env: {}, platform: 'linux' });
  const cache = new CatalogCache(join(sb.home, '.cache', 'via', 'catalog'));
  for (const p of providers) cache.write(config.servers.find((s) => s.name === p.provider)!, p.tools as never);
  const root = await spawnTimed(process.execPath, [DIST], { env: sb.env, cwd: sb.project });
  if (root.code !== 0) throw new Error(`scale scenario: via exited with ${String(root.code)}: ${root.stderr}`);
  return { sb, describe: root.stdout.split('\n')[0] ?? '' };
}

let scenarioResults = new Map<string, Paired>();

/** A scenario command and its target, in milliseconds over bare node: `limit` (strictly below when `strict`, else at most). */
interface ScenarioCommand {
  id: string;
  args: string[];
  limit?: number;
  strict?: boolean;
}

async function benchScenarios(base: Sandbox): Promise<void> {
  section('1b. cold start in scenarios nearer to real use (spawn to exit, warm compile cache and warm catalog)');
  const bare = await measure(process.execPath, ['-e', '0'], { env: base.env, cwd: base.project });
  const esmFile = join(base.tmp, 'empty.mjs');
  writeFileSync(esmFile, 'export {};\n');
  const esm = await measure(process.execPath, [esmFile], { env: base.env, cwd: base.project });
  const builds = [{ label: 'this build', dist: DIST_DIR }, ...(COMPARE_DIST ? [{ label: 'compared build', dist: COMPARE_DIST }] : [])];
  const rows: string[][] = [
    ['node -e 0', '-', '', ms(bare.median), ms(bare.p95), ms(bare.min), '', '-', ''],
    ['node empty.mjs (an ES module entry)', '-', '', ms(esm.median), ms(esm.p95), ms(esm.min), '', signed(esm.median - bare.median), 'the floor of an ESM entry point'],
  ];
  const framework = await makeFrameworkScenario();
  const scale = await makeScaleScenario();
  const results = new Map<string, Paired>();
  try {
    const scenarios: Array<{ name: string; sb: Sandbox; env: Record<string, string>; commands: ScenarioCommand[] }> = [
      {
        name: '8 providers, warm daemon',
        sb: base,
        env: withDaemon(base.env),
        commands: [
          { id: 'via', args: [], limit: TARGET_DAEMON_OVER_NODE, strict: true },
          { id: 'via github', args: ['github'] },
          { id: 'via find', args: ['find', 'create issue'], limit: TARGET_DAEMON_OVER_NODE, strict: true },
        ],
      },
      {
        name: 'framework configs',
        sb: framework.sb,
        env: framework.sb.env,
        commands: [
          { id: 'via', args: [], limit: TARGET_FRAMEWORK_OVER_NODE, strict: true },
          { id: 'via find', args: ['find', 'create issue'], limit: TARGET_FRAMEWORK_OVER_NODE, strict: true },
        ],
      },
      {
        name: '1,000 tools / 50 providers',
        sb: scale.sb,
        env: scale.sb.env,
        commands: [{ id: 'via', args: [] }, { id: 'via find', args: ['find', 'create issue'], limit: TARGET_FIND_PROCESS_OVER_NODE }, { id: 'via <provider>', args: ['github'] }],
      },
    ];
    for (const sc of scenarios) {
      for (const c of sc.commands) {
        const contenders: Contender[] = [
          { label: 'bare', command: process.execPath, args: ['-e', '0'], env: () => sc.sb.env },
          ...builds.map((b) => ({ label: b.label, command: process.execPath, args: [join(b.dist, 'via.js'), ...c.args], env: () => sc.env })),
        ];
        const measured = await measureAlternating(contenders, sc.sb.project);
        const pairedBare = measured.get('bare')!;
        for (const b of builds) {
          const m = measured.get(b.label)!;
          const delta = m.median - pairedBare.median;
          if (b.label === 'this build') results.set(`${sc.name}: ${c.id}`, { stats: m, bare: pairedBare, delta });
          const target = b.label !== 'this build' || c.limit === undefined ? '' : c.strict ? verdict(delta, c.limit) : verdictAtMost(delta, c.limit);
          rows.push([sc.name, c.id, builds.length > 1 ? b.label : '', ms(m.median), ms(m.p95), ms(m.min), ms(pairedBare.median), signed(delta), target]);
        }
      }
      if (sc.sb === base) await stopDaemon(base).catch(() => undefined);
    }
  } finally {
    rmSync(framework.sb.root, { recursive: true, force: true });
    rmSync(scale.sb.root, { recursive: true, force: true });
  }
  printTable(['scenario', 'command', 'build', 'median ms', 'p95 ms', 'min ms', 'node -e 0 (paired) ms', 'over node -e 0 ms', 'target (over node -e 0)'], rows);
  console.log(
    `framework configs = ${framework.describe}; 1,000 tools = ${scale.describe}. Targets, over \`node -e 0\`: warm daemon \`via\` and \`via find\` < ${TARGET_DAEMON_OVER_NODE} ms; framework configs \`via\` and \`via find\` < ${TARGET_FRAMEWORK_OVER_NODE} ms; whole-process \`via find\` over 1,000 tools at most ${TARGET_FIND_PROCESS_OVER_NODE} ms (the library path is section 2). The daemon rows start the sandbox daemon on the first run (a warmup) and stop it afterwards. Every row alternates with \`node -e 0\`, and with --compare the two builds run alternately too.\n`,
  );
  scenarioResults = results;
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

interface RestoredChild {
  cold: { restore: number; index: number; query: number; render: number };
}

/**
 * Runs in a fresh process: what a one-shot `via find` pays when every provider's build is in the
 * prebuilt-catalog cache (src/cli/view-cache.ts): read the snapshots, restore, index, query. The
 * snapshots come from the parent, which built them; the raw tool lists are never parsed here.
 */
function restoredChild(snapshotFile: string): RestoredChild {
  const snapshots = JSON.parse(readFileSync(snapshotFile, 'utf8')) as Array<{ provider: string; head: unknown; body: string; n: number }>;
  const time = <T>(f: () => T): [T, number] => {
    const t = performance.now();
    const v = f();
    return [v, performance.now() - t];
  };
  const terms = new Map<string, RestoredTerms>();
  const [catalog, restore] = time(() => ({
    warnings: [],
    providers: snapshots.map((snap) => {
      // The raw list stays unread: `source` would only be called for a tool definition.
      const restored = restoreProvider(snap.provider, snap.head, snap.body, () => [])!;
      terms.set(snap.provider, restored.terms);
      return restored.catalog;
    }),
  }));
  const known = { get: (tool: CatalogTool): DocTerms | undefined => terms.get(tool.provider)?.get(tool) };
  const [index, indexMs] = time(() => new SearchIndex(catalog, undefined, { precomputed: known }));
  const [hits, query] = time(() => index.search(FIND_QUERIES[0]!, { limit: 10 }));
  const [, render] = time(() => renderFind(hits, FIND_QUERIES[0]!));
  return { cold: { restore, index: indexMs, query, render } };
}

async function benchFind(sb: Sandbox): Promise<{ coldTotal: number; restoredTotal: number; steadyQuery: number }> {
  section('2. `find` over 1,000 tools (in-process, real catalog APIs)');
  const children: FindChild[] = [];
  for (let i = 0; i < WARMUP + Math.max(RUNS / 2, 8); i += 1) {
    const r = await spawnTimed(process.execPath, [process.argv[1]!, '--child-find'], { env: sb.env, cwd: ROOT });
    if (r.code !== 0) throw new Error(`find child failed: ${r.stderr}`);
    if (i >= WARMUP) children.push(JSON.parse(r.stdout) as FindChild);
  }
  // The same catalog from the prebuilt cache: snapshots made here, restored in fresh processes.
  const synthesized = synthesizeProviders(loadBaseProviders(FIXTURES));
  const built = buildCatalog(synthesized);
  const snapshotFile = join(sb.root, 'snapshots.json');
  writeFileSync(
    snapshotFile,
    JSON.stringify(
      built.providers.map((p) => {
        const source = synthesized.find((x) => normalizeProviderName(x.provider) === p.provider)!.tools;
        const { head, body } = snapshotProvider(p, source);
        return { provider: p.provider, head, body, n: source.length };
      }),
    ),
  );
  const restoredRuns: RestoredChild[] = [];
  for (let i = 0; i < WARMUP + Math.max(RUNS / 2, 8); i += 1) {
    const r = await spawnTimed(process.execPath, [process.argv[1]!, '--child-find-restored', snapshotFile], { env: sb.env, cwd: ROOT });
    if (r.code !== 0) throw new Error(`restored find child failed: ${r.stderr}`);
    if (i >= WARMUP) restoredRuns.push(JSON.parse(r.stdout) as RestoredChild);
  }
  const tools = children[0]!.tools;
  const pick = (f: (c: FindChild) => number) => stats(children.map(f));
  const pickRestored = (f: (c: RestoredChild) => number) => stats(restoredRuns.map(f));
  const row = (label: string, s: Stats, target = ''): string[] => [label, ms(s.median), ms(s.p95), ms(s.min), target];
  const coldTotal = pick((c) => c.cold.build + c.cold.index + c.cold.query);
  const restoredTotal = pickRestored((c) => c.cold.restore + c.cold.index + c.cold.query);
  const steadyQuery = pick((c) => c.steady.query);
  printTable(
    ['phase', 'median ms', 'p95 ms', 'min ms', `library target < ${TARGET_FIND_1000} ms`],
    [
      row('catalog build (split), first call', pick((c) => c.cold.build)),
      row('index build, first call', pick((c) => c.cold.index)),
      row('query, first call', pick((c) => c.cold.query)),
      row('render hits, first call', pick((c) => c.cold.render)),
      row('build + index + first query (one-shot CLI, no prebuilt cache)', coldTotal, 'reference, no target'),
      row('prebuilt cache: restore the snapshots, first call', pickRestored((c) => c.cold.restore)),
      row('prebuilt cache: index from stored terms (restores the tools), first call', pickRestored((c) => c.cold.index)),
      row('prebuilt cache: query, first call', pickRestored((c) => c.cold.query)),
      row('prebuilt cache: restore + index + first query (one-shot CLI)', restoredTotal, verdict(restoredTotal.median, TARGET_FIND_1000)),
      row('catalog build, steady state', pick((c) => c.steady.build)),
      row('index build, steady state', pick((c) => c.steady.index)),
      row('query, steady state', steadyQuery, 'reference, no target'),
    ],
  );
  console.log(`catalog: ${tools} tools, ${50} providers (deterministic, seed 1); ${children.length} fresh processes, "first call" is the first use in each; steady state is the median of 15 rounds x ${FIND_QUERIES.length} queries. The prebuilt-cache rows read snapshots written by this process in fresh ones that never ran the build code; the whole-process \`via find\` over this catalog is in section 1b. The target applies to the "prebuilt cache: restore + index + first query" row, the library path of a one-shot CLI that finds its catalog in the cache.\n`);
  return { coldTotal: coldTotal.median, restoredTotal: restoredTotal.median, steadyQuery: steadyQuery.median };
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
      `import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
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


interface Loaded {
  chunks: number;
  kib: number;
  /** Packages still loaded from node_modules (only the native keychain binding can be one). */
  packages: string[];
  /** Bundled libraries whose code is in a loaded chunk. */
  libraries: string[];
}

function summarizeTrace(trace: string): Loaded {
  const urls = trace.split('\n').filter(Boolean);
  let kib = 0;
  const chunks = new Set<string>();
  const packages = new Set<string>();
  const libraries = new Set<string>();
  for (const url of urls) {
    if (!url.startsWith('file://')) continue;
    const path = fileURLToPath(url);
    const nm = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path);
    if (nm) packages.add(nm[1]!);
    else if (path.startsWith(DIST_DIR)) {
      chunks.add(path);
      kib += statSync(path).size / 1024;
      for (const name of featuresOf(readFileSync(path, 'utf8'))) libraries.add(name);
    }
  }
  return { chunks: chunks.size, kib, packages: [...packages].sort(), libraries: [...libraries].sort() };
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

/** Node's own modules that a command that only prints a table has no business initialising: each costs milliseconds. */
const AVOIDABLE_BUILTINS = ['crypto', 'net', 'tty', 'stream', 'fs/promises', 'internal/fs/promises', 'internal/fs/streams', 'readline', 'child_process'];

async function traceBuiltins(sb: Sandbox, args: string[]): Promise<string[]> {
  const file = join(sb.root, 'builtins.txt');
  rmSync(file, { force: true });
  const r = await spawnTimed(process.execPath, ['--require', BUILTIN_TRACE, DIST, ...args], { env: { ...sb.env, VIA_BUILTIN_TRACE: file }, cwd: sb.project });
  if (r.code === null || r.code > 6) throw new Error(`traced run failed: ${r.stderr}`);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('NativeModule ')).map((l) => l.slice('NativeModule '.length)) : [];
}

async function benchLoads(sb: Sandbox): Promise<boolean> {
  section('4. modules loaded per command (bundle chunks and the libraries inside them)');
  const browse: Array<{ id: string; args: string[]; trivial: boolean }> = [
    { id: '--version', args: ['--version'], trivial: true },
    { id: '-h', args: ['-h'], trivial: true },
    ...COLD_COMMANDS.slice(2).map((c) => ({ id: c.id, args: c.args, trivial: false })),
  ];
  let ok = true;
  const rows: string[][] = [];
  const add = (id: string, loaded: Loaded, trivial: boolean, mayLoadClient: boolean, builtins: string[] = []): void => {
    let status = 'ok';
    const avoidable = builtins.filter((m) => AVOIDABLE_BUILTINS.includes(m));
    const all = [...loaded.libraries, ...loaded.packages];
    if (trivial && all.length > 0) status = 'FAIL: loads a library';
    else if (!mayLoadClient && loaded.libraries.some((l) => l === 'mcp-sdk' || l === 'ajv' || l === 'zod')) status = 'FAIL: MCP SDK or ajv on a cached browse';
    if (!mayLoadClient && avoidable.length > 0) status = `FAIL: initialises ${avoidable.join(', ')}`;
    if (status !== 'ok') ok = false;
    rows.push([id, String(loaded.chunks), loaded.kib.toFixed(0), all.join(', ') || '(none)', builtins.length === 0 ? '-' : String(builtins.length), status]);
  };
  for (const c of browse) add(c.id, await traceLoads(sb, c.args), c.trivial, false, await traceBuiltins(sb, c.args));

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
  printTable(['command', 'bundle chunks', 'KiB', 'libraries in the loaded chunks', 'node internals', 'check'], rows);
  console.log(`check: --version and -h load no library at all; cached browse commands (root, provider, find) load neither the MCP SDK nor ajv, and initialise none of ${AVOIDABLE_BUILTINS.join(', ')} (\`node internals\` is the length of process.moduleLoadList, scripts/lib/builtin-trace.cjs). Libraries are recognised by a marker name inside the loaded chunks (scripts/lib/chunk-features.ts); a chunk shared with other code counts whole.\n`);
  return ok;
}


// ---------------------------------------------------------------------------------------------
// 5. hot daemon (0.2)

/** Environment that lets the CLI use (and start) the sandbox's daemon. */
const withDaemon = (env: Record<string, string>): Record<string, string> => ({ ...env, VIA_NO_DAEMON: '0' });

interface DaemonInfo {
  pid: number;
  rssBytes: number;
  sessions: unknown[];
}

async function daemonInfo(sb: Sandbox): Promise<DaemonInfo | undefined> {
  const r = await spawnTimed(process.execPath, [DIST, 'daemon', 'status', '-o', 'json'], { env: withDaemon(sb.env), cwd: sb.project });
  if (r.code !== 0) return undefined;
  const status = JSON.parse(r.stdout) as { running: boolean } & Partial<DaemonInfo>;
  return status.running ? { pid: status.pid!, rssBytes: status.rssBytes!, sessions: status.sessions ?? [] } : undefined;
}

/** `via daemon stop` in the sandbox, so no benchmark leaves a daemon behind. */
async function stopDaemon(sb: Sandbox): Promise<void> {
  await spawnTimed(process.execPath, [DIST, 'daemon', 'stop'], { env: withDaemon(sb.env), cwd: sb.project });
  for (let i = 0; i < 50 && (await daemonInfo(sb)); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
}

const MiB = 1024 * 1024;

/** Anonymous and file-backed resident memory of a process in bytes (Linux /proc; the node binary's own pages are the file part). */
function residentSplit(pid: number): { anon: number; file: number } | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = (key: string): number | undefined => {
      const m = new RegExp(`${key}:\\s+(\\d+)`).exec(status);
      return m ? Number(m[1]) * 1024 : undefined;
    };
    const anon = kb('RssAnon');
    const file = kb('RssFile');
    return anon === undefined || file === undefined ? undefined : { anon, file };
  } catch {
    return undefined;
  }
}

interface DaemonResult {
  overhead: number;
  /** What the memory target is measured on: RssAnon where /proc has it, RSS otherwise. */
  metric: 'RssAnon' | 'RSS';
  targetMiB: number;
  idleMiB: number;
  peakMiB: number;
}

async function benchDaemon(): Promise<DaemonResult | undefined> {
  section('5. hot daemon: call overhead and resident memory');
  if (process.platform === 'win32') {
    console.log('skipped: the daemon is not available on Windows before 0.3.\n');
    return undefined;
  }
  const server = await startServer();
  const sb = makeSandbox();
  let standalone: ReturnType<typeof spawn> | undefined;
  try {
    const stdioServer = join(FIXTURES, 'mcp', 'cli-stdio-server.mjs');
    writeConfig(
      sb,
      [{ name: 'gh', url: server.url }],
      `daemon:\n  idleTimeout: 120\n`,
    );
    // Append the stdio server (its session is what grows the daemon).
    const configPath = join(sb.home, '.config', 'via', 'config.yaml');
    writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}  job:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(stdioServer)}]\n`);
    const daemonEnv = withDaemon(sb.env);

    // Idle memory: a daemon that has just started and holds no session.
    // Started the way the CLI starts it (V8 and malloc settings of daemonRuntime), not with a bare `node`.
    // `--plain-daemon` starts it with a bare `node` instead: the way a build from before those settings is measured.
    const runtime = argv.includes('--plain-daemon') ? { flags: [], env: {} } : daemonRuntime(process.execPath);
    standalone = spawn(process.execPath, [...runtime.flags, DIST, 'daemon', 'run'], { env: { ...daemonEnv, ...runtime.env }, cwd: sb.project, stdio: 'ignore' });
    let info: DaemonInfo | undefined;
    for (let i = 0; i < 100 && !info; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      info = await daemonInfo(sb);
    }
    if (!info) throw new Error('the daemon did not start');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const idle = (await daemonInfo(sb))!.rssBytes;
    const idleSplit = residentSplit(info.pid);

    const call = ['gh', 'echo_text', '--message', 'hi'];
    const first = await spawnTimed(process.execPath, [DIST, ...call], { env: daemonEnv, cwd: sb.project });
    if (first.code !== 0 || !first.stdout.includes('echo: hi')) throw new Error(`call through the daemon failed (${first.code}): ${first.stderr}`);
    const afterHttp = (await daemonInfo(sb))!.rssBytes;
    const httpSplit = residentSplit(info.pid);
    const job = await spawnTimed(process.execPath, [DIST, 'job', 'run_job'], { env: daemonEnv, cwd: sb.project });
    if (job.code !== 0) throw new Error(`stdio call through the daemon failed (${job.code}): ${job.stderr}`);
    const afterStdio = (await daemonInfo(sb))!.rssBytes;
    const stdioSplit = residentSplit(info.pid);

    // In-process timings, warm JIT: the daemon rows connect to the daemon socket from this process.
    const env = sb.env;
    const viaRun = (overrides: Record<string, string>) => async (): Promise<void> => {
      let out = '';
      const code = await run(call, {
        env: { ...env, ...overrides },
        cwd: sb.project,
        home: sb.home,
        platform: process.platform,
        stdout: { write: (x: string) => void (out += x) },
        stderr: { write: () => undefined },
        readStdin: async () => '',
        daemonCommand: { command: process.execPath, args: [DIST] },
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
    const reuse = new Client({ name: 'bench', version: '0.0.0' });
    await reuse.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    const reused = await timeAsync(async () => void (await reuse.callTool({ name: 'echo_text', arguments: { message: 'hi' } })));
    await reuse.close();
    await viaRun({ VIA_NO_DAEMON: '1' })(); // fills the catalog cache
    const direct = await timeAsync(viaRun({ VIA_NO_DAEMON: '1' }));
    const hot = await timeAsync(viaRun({ VIA_NO_DAEMON: '0' }));

    // Process level: what one `via` invocation costs with and without the daemon.
    const bare = await measure(process.execPath, ['-e', '0'], { env: sb.env, cwd: sb.project });
    const procDirect = await measure(process.execPath, [DIST, ...call], { env: sb.env, cwd: sb.project });
    const procHot = await measure(process.execPath, [DIST, ...call], { env: daemonEnv, cwd: sb.project });
    const afterAll = (await daemonInfo(sb))!;
    const allSplit = residentSplit(info.pid);

    const row = (label: string, s: Stats, extra = ''): string[] => [label, ms(s.median), ms(s.p95), ms(s.min), extra];
    const delta = (a: Stats, b: Stats): Stats => ({ median: a.median - b.median, p95: a.p95 - b.p95, min: a.min - b.min });
    const overhead = delta(hot, reused);
    printTable(
      ['scenario', 'median ms', 'p95 ms', 'min ms', 'notes'],
      [
        row('in-process: SDK callTool, reused connection', reused, 'the floor a persistent connection reaches'),
        row('in-process: run([gh echo_text ...]), no daemon', direct, 'fresh connection per call'),
        row('in-process: run([gh echo_text ...]), hot daemon', hot, 'config + cache + validate + daemon round trip + render'),
        row('  hot daemon over reused SDK call', overhead, `target < ${TARGET_DAEMON_OVERHEAD} ms: ${verdict(overhead.median, TARGET_DAEMON_OVERHEAD)}`),
        row('  hot daemon vs no daemon', delta(hot, direct), 'negative: the daemon saves'),
        row('process: node -e 0', bare),
        row('process: node dist/via.js gh echo_text, no daemon', procDirect, 'loads the MCP SDK and ajv'),
        row('process: node dist/via.js gh echo_text, hot daemon', procHot, 'loads neither'),
        row('  hot daemon over bare node', delta(procHot, bare), 'the whole CLI cost of a call'),
      ],
    );
    // The memory target is on anonymous memory (RssAnon): RSS also counts the node binary's pages,
    // which are shared with every other node process. Without /proc/<pid>/status, RSS stands in.
    const readings = [
      { label: 'idle, just started', rss: idle, split: idleSplit },
      { label: 'after one HTTP session and call', rss: afterHttp, split: httpSplit },
      { label: 'after a stdio session and call', rss: afterStdio, split: stdioSplit },
      { label: `after ${(WARMUP + RUNS) * 3 + 4} more calls`, rss: afterAll.rssBytes, split: allSplit },
    ];
    const metric = readings.every((r) => r.split) ? 'RssAnon' : 'RSS';
    const targetMiB = metric === 'RssAnon' ? TARGET_DAEMON_ANON_MIB : TARGET_DAEMON_RSS_MIB;
    const measuredMiB = (r: (typeof readings)[number]): number => (metric === 'RssAnon' ? r.split!.anon : r.rss) / MiB;
    printTable(
      ['daemon resident memory', 'RSS MiB', 'RssAnon MiB', 'RssFile MiB', `${metric} (target < ${targetMiB} MiB, excluding stdio children)`],
      readings.map((r) => [
        r.label,
        (r.rss / MiB).toFixed(1),
        r.split ? (r.split.anon / MiB).toFixed(1) : 'n/a',
        r.split ? (r.split.file / MiB).toFixed(1) : 'n/a',
        `${measuredMiB(r).toFixed(1)}: ${verdict(measuredMiB(r), targetMiB)}`,
      ]),
    );
    console.log(
      `the daemon runs as a separate process started with \`via daemon run\` in the sandbox and stopped with \`via daemon stop\` afterwards; RSS is what \`via daemon status\` reports. The target is judged on ${
        metric === 'RssAnon'
          ? "RssAnon (anonymous memory, /proc/<pid>/status): the file part is the node binary mapped into the process, about 44 MiB, shared with every other node process and not under via's control."
          : `RSS, labelled as such: this platform (${process.platform}) has no RssAnon, so the less strict RSS < ${TARGET_DAEMON_RSS_MIB} MiB stands in.`
      }\n`,
    );
    return { overhead: overhead.median, metric, targetMiB, idleMiB: measuredMiB(readings[0]!), peakMiB: Math.max(...readings.map(measuredMiB)) };
  } finally {
    await stopDaemon(sb).catch(() => undefined);
    if (standalone && standalone.exitCode === null) standalone.kill('SIGKILL');
    await server.close();
    rmSync(sb.root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------

function environmentLines(): string[] {
  const c = cpus();
  return [
    `date: ${new Date().toISOString().slice(0, 10)}`,
    `cpu: ${c[0]?.model ?? 'unknown'} x ${c.length}`,
    `memory: ${(totalmem() / 1024 ** 3).toFixed(1)} GiB`,
    `os: ${osType()} ${release()} ${arch()}`,
    `node: ${process.version}`,
    `runs: ${RUNS} measured + ${WARMUP} warmup per row`,
    // Other work on the machine inflates every start-up number; the delta over node -e 0 is only as good as this is low.
    `load average at start (1 / 5 / 15 min): ${loadavg().map((x) => x.toFixed(2)).join(' / ')}${process.platform === 'win32' ? ' (always 0 on Windows)' : ''}`,
  ];
}

async function main(): Promise<void> {
  const restoredAt = argv.indexOf('--child-find-restored');
  if (restoredAt !== -1) {
    process.stdout.write(`${JSON.stringify(restoredChild(argv[restoredAt + 1]!))}\n`);
    return;
  }
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

    const cold = wanted('cold') ? await benchColdStart(sb) : new Map<string, Paired>();
    if (wanted('scenarios')) await benchScenarios(sb);
    const findResult = wanted('find') ? await benchFind(sb) : undefined;
    if (wanted('call')) await benchCall();
    if (wanted('loads')) healthy = (await benchLoads(sb)) && healthy;
    const daemonResult = wanted('daemon') ? await benchDaemon() : undefined;

    section('Summary against the targets');
    // Start-up targets are on the milliseconds a command adds to `node -e 0` (measured alternately, same run).
    const startup = (label: string, r: Paired | undefined, limit: number, strict = false): string[] => [
      label,
      r === undefined ? 'n/a' : `${ms(r.stats.median)} ms (${signed(r.delta)} over node -e 0 at ${ms(r.bare.median)})`,
      r === undefined ? 'not measured' : strict ? verdict(r.delta, limit) : verdictAtMost(r.delta, limit),
    ];
    const cap = TARGET_COLD_OVER_NODE;
    const ofScenario = (key: string): Paired | undefined => scenarioResults.get(key);
    printTable(
      ['target', 'measured (median)', 'result'],
      [
        startup(`cold start, at most +${cap} ms over node -e 0: via (root, 180 tools, no daemon)`, cold.get('via (root)'), cap),
        startup(`cold start, at most +${cap} ms over node -e 0: via github (180 tools, no daemon)`, cold.get('via github'), cap),
        startup(`cold start, at most +${cap} ms over node -e 0: via find (180 tools, no daemon)`, cold.get('via find'), cap),
        startup(`warm daemon, < +${TARGET_DAEMON_OVER_NODE} ms over node -e 0: via`, ofScenario('8 providers, warm daemon: via'), TARGET_DAEMON_OVER_NODE, true),
        startup(`warm daemon, < +${TARGET_DAEMON_OVER_NODE} ms over node -e 0: via find`, ofScenario('8 providers, warm daemon: via find'), TARGET_DAEMON_OVER_NODE, true),
        startup(`framework configs, < +${TARGET_FRAMEWORK_OVER_NODE} ms over node -e 0: via`, ofScenario('framework configs: via'), TARGET_FRAMEWORK_OVER_NODE, true),
        startup(`framework configs, < +${TARGET_FRAMEWORK_OVER_NODE} ms over node -e 0: via find`, ofScenario('framework configs: via find'), TARGET_FRAMEWORK_OVER_NODE, true),
        startup(`whole-process find, at most +${TARGET_FIND_PROCESS_OVER_NODE} ms over node -e 0: via find over 1,000 tools`, ofScenario('1,000 tools / 50 providers: via find'), TARGET_FIND_PROCESS_OVER_NODE),
        findResult
          ? [`find over 1,000 tools < ${TARGET_FIND_1000} ms, library path: prebuilt cache, restore + index + first query`, `${ms(findResult.restoredTotal)} ms`, verdict(findResult.restoredTotal, TARGET_FIND_1000)]
          : [`find over 1,000 tools < ${TARGET_FIND_1000} ms, library path`, 'n/a', 'not measured'],
        daemonResult
          ? [`hot daemon overhead < ${TARGET_DAEMON_OVERHEAD} ms (over a reused SDK call)`, `${ms(daemonResult.overhead)} ms`, verdict(daemonResult.overhead, TARGET_DAEMON_OVERHEAD)]
          : [`hot daemon overhead < ${TARGET_DAEMON_OVERHEAD} ms`, 'n/a', 'not measured'],
        daemonResult
          ? [
              `daemon memory ${daemonResult.metric} < ${daemonResult.targetMiB} MiB (idle / highest seen)`,
              `${daemonResult.idleMiB.toFixed(1)} / ${daemonResult.peakMiB.toFixed(1)} MiB ${daemonResult.metric}`,
              verdict(daemonResult.peakMiB, daemonResult.targetMiB),
            ]
          : [`daemon memory RssAnon < ${TARGET_DAEMON_ANON_MIB} MiB`, 'n/a', 'not measured'],
      ],
    );
    console.log(`load average at the end (1 / 5 / 15 min): ${loadavg().map((x) => x.toFixed(2)).join(' / ')}`);
    console.log('reference rows without a target (no prebuilt cache, resident index, via github through the daemon, via <provider> over 1,000 tools) are in their sections. Timings are reported against the targets, never asserted.\n');
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
  process.exitCode = healthy ? 0 : 1;
}

await main();
