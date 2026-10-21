// The `bench:eval` command (scripts/bench-eval.ts is a thin entry point): argument parsing,
// preflight checks, running the evaluation and writing the results.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { loadSuite } from '../harness/load';
import { makeRunners, probeMcp2cli, probeMcpc, viaVersion } from '../harness/runners';
import { summarize } from './aggregate';
import { createAnthropicClient, DEFAULT_MODEL } from './anthropic';
import { fakeModelFactory } from './fake';
import { successOf } from './judge';
import { formatConsole, formatJson, formatMarkdown, type EvalMeta } from './report';
import { runEval } from './run';
import { CONDITIONS, type Condition, type ModelFactory } from './types';

export interface EvalArgs {
  trials: number;
  tasks: string[];
  conditions: Condition[];
  model: string;
  maxTurns: number;
  maxTokens: number;
  concurrency: number;
  out?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  cache: boolean;
  fake: boolean;
  via: string;
  mcp2cli: string | false;
  mcpc: string | false;
  help: boolean;
}

export const USAGE = `usage: npm run bench:eval -- [options]

  --trials <n>         runs per task and condition (default 3)
  --task <text>        only tasks whose id contains the text (repeatable)
  --condition <name>   native, via, mcp2cli or mcpc (repeatable or comma-separated; default all)
  --model <id>         model to evaluate (default ${DEFAULT_MODEL})
  --max-turns <n>      model turns per run (default 25)
  --max-tokens <n>     output token limit of one reply (default 16000)
  --concurrency <n>    runs in parallel (default 4)
  --out <base>         write <base>.md and <base>.json (default bench/results/eval-<date>)
  --effort <level>     output effort: low, medium, high, xhigh or max (default: the model's)
  --cache              automatic prompt caching of the conversation prefix
  --fake-model         scripted model, no API key: checks the pipeline, measures nothing
  --via <path>         the built CLI (default dist/via.js)
  --mcp2cli <path>     mcp2cli executable (default: \`mcp2cli\` on PATH)
  --no-mcp2cli         leave out the mcp2cli condition
  --mcpc <path>        mcpc executable (default: \`mcpc\` on PATH)
  --no-mcpc            leave out the mcpc condition

Needs ANTHROPIC_API_KEY (and honors ANTHROPIC_BASE_URL) unless --fake-model is given.
`;

export function parseArgs(argv: string[]): EvalArgs {
  const args: EvalArgs = {
    trials: 3,
    tasks: [],
    conditions: [],
    model: DEFAULT_MODEL,
    maxTurns: 25,
    maxTokens: 16_000,
    concurrency: 4,
    cache: false,
    fake: false,
    via: 'dist/via.js',
    mcp2cli: 'mcp2cli',
    mcpc: 'mcpc',
    help: false,
  };
  const value = (i: number): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${argv[i]} needs a value`);
    return v;
  };
  const count = (i: number, min: number): number => {
    const n = Number(value(i));
    if (!Number.isInteger(n) || n < min) throw new Error(`${argv[i]} needs an integer >= ${min}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--trials') args.trials = count(i++, 1);
    else if (arg === '--task') args.tasks.push(value(i++));
    else if (arg === '--condition') {
      for (const name of value(i++).split(',')) {
        if (!(CONDITIONS as readonly string[]).includes(name)) throw new Error(`unknown condition: ${name} (native, via, mcp2cli, mcpc)`);
        if (!args.conditions.includes(name as Condition)) args.conditions.push(name as Condition);
      }
    } else if (arg === '--model') args.model = value(i++);
    else if (arg === '--max-turns') args.maxTurns = count(i++, 1);
    else if (arg === '--max-tokens') args.maxTokens = count(i++, 256);
    else if (arg === '--concurrency') args.concurrency = count(i++, 1);
    else if (arg === '--out') args.out = value(i++);
    else if (arg === '--effort') {
      const level = value(i++);
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(level)) throw new Error(`unknown effort: ${level}`);
      args.effort = level as NonNullable<EvalArgs['effort']>;
    } else if (arg === '--cache') args.cache = true;
    else if (arg === '--fake-model') args.fake = true;
    else if (arg === '--via') args.via = value(i++);
    else if (arg === '--mcp2cli') args.mcp2cli = value(i++);
    else if (arg === '--no-mcp2cli') args.mcp2cli = false;
    else if (arg === '--mcpc') args.mcpc = value(i++);
    else if (arg === '--no-mcpc') args.mcpc = false;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.conditions.length === 0) args.conditions = [...CONDITIONS];
  return args;
}

const MISSING_KEY = `bench:eval needs an API key: set ANTHROPIC_API_KEY (ANTHROPIC_BASE_URL is honored too).
The evaluation calls a live model and spends tokens; see bench/README.md.
To check the pipeline without a key, run: npm run bench:eval -- --fake-model
`;

export async function main(argv: string[], io: { stdout: (s: string) => void; stderr: (s: string) => void }): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    io.stdout(USAGE);
    return 0;
  }
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (!args.fake && !hasKey) {
    io.stderr(MISSING_KEY);
    return 2;
  }

  const root = process.cwd();
  if (!existsSync(resolve(root, 'bench/suite.yaml'))) throw new Error('run from the repository root (bench/suite.yaml not found)');
  const date = new Date().toISOString().slice(0, 10);

  // Where results go. The scripted model never writes under bench/results/: those files are records.
  const out = args.out ?? (args.fake ? undefined : `bench/results/eval-${date}`);
  if (args.fake && out !== undefined) {
    // `relative` gives an absolute path when the two are on different Windows drives, and `..` only
    // names a parent when it is a whole segment (a directory called `..x` is inside).
    const rel = relative(resolve(root, 'bench/results'), resolve(root, out));
    const outside = isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`);
    if (!outside) throw new Error('--fake-model output must not go under bench/results/ (it is not a result)');
  }

  const loaded = loadSuite(root, args.tasks);
  for (const task of loaded.tasks) successOf(task);

  const viaBin = resolve(root, args.via);
  if (args.conditions.includes('via') && !existsSync(viaBin)) throw new Error(`${args.via} not found; run \`npm run build\` first`);

  let mcp2cli: { bin: string; version: string } | undefined;
  let mcp2cliSkipped: string | undefined;
  let conditions = args.conditions;
  if (conditions.includes('mcp2cli')) {
    if (args.mcp2cli === false) {
      mcp2cliSkipped = 'disabled with --no-mcp2cli';
    } else {
      const probe = await probeMcp2cli(args.mcp2cli);
      if ('version' in probe) {
        mcp2cli = { bin: args.mcp2cli, version: probe.version };
        if (probe.version !== loaded.suite.mcp2cli.version) io.stderr(`note: mcp2cli ${probe.version} is installed, the vendored skill is from ${loaded.suite.mcp2cli.version}\n`);
      } else {
        mcp2cliSkipped = probe.skipped;
      }
    }
    if (!mcp2cli) {
      conditions = conditions.filter((c) => c !== 'mcp2cli');
      io.stderr(`mcp2cli condition skipped: ${mcp2cliSkipped}\n`);
    }
  }
  let mcpc: { bin: string; version: string } | undefined;
  let mcpcSkipped: string | undefined;
  if (conditions.includes('mcpc')) {
    if (args.mcpc === false) {
      mcpcSkipped = 'disabled with --no-mcpc';
    } else {
      const probe = await probeMcpc(args.mcpc);
      if ('version' in probe) {
        mcpc = { bin: args.mcpc, version: probe.version };
        if (probe.version !== loaded.suite.mcpc.version) io.stderr(`note: mcpc ${probe.version} is installed, the vendored skill is from ${loaded.suite.mcpc.version}\n`);
      } else {
        mcpcSkipped = probe.skipped;
      }
    }
    if (!mcpc) {
      conditions = conditions.filter((c) => c !== 'mcpc');
      io.stderr(`mcpc condition skipped: ${mcpcSkipped}\n`);
    }
  }
  if (conditions.length === 0) throw new Error('no condition left to run');

  let model: ModelFactory;
  let modelName: string;
  if (args.fake) {
    model = fakeModelFactory(loaded);
    modelName = 'fake (scripted)';
  } else {
    const client = await createAnthropicClient({ model: args.model, cache: args.cache, ...(args.effort ? { effort: args.effort } : {}) });
    model = () => client;
    modelName = args.model;
  }

  io.stderr(`running ${loaded.tasks.length} task(s) × ${conditions.join(', ')} × ${args.trials} trial(s) with ${modelName}\n`);
  const runs = await runEval({
    loaded,
    conditions,
    trials: args.trials,
    maxTurns: args.maxTurns,
    maxTokens: args.maxTokens,
    concurrency: args.concurrency,
    runners: makeRunners({ viaBin, ...(mcp2cli ? { mcp2cli } : {}), ...(mcpc ? { mcpc } : {}) }),
    model,
    log: (line) => io.stderr(`${line}\n`),
  });

  const meta: EvalMeta = {
    date,
    model: modelName,
    fake: args.fake,
    trials: args.trials,
    maxTurns: args.maxTurns,
    maxTokens: args.maxTokens,
    ...(args.effort ? { effort: args.effort } : {}),
    cache: args.cache,
    via: existsSync(viaBin) ? await viaVersion(viaBin, root) : 'n/a',
    node: process.version,
    mounted: loaded.suite.mounted,
    tasks: loaded.tasks.map((t) => t.id),
    conditions,
    ...(mcp2cli ? { mcp2cliVersion: mcp2cli.version } : {}),
    ...(mcp2cliSkipped ? { mcp2cliSkipped } : {}),
    ...(mcpc ? { mcpcVersion: mcpc.version } : {}),
    ...(mcpcSkipped ? { mcpcSkipped } : {}),
  };
  const summary = summarize(runs, { conditions, taskOrder: meta.tasks, fake: args.fake, ...(mcp2cliSkipped ? { mcp2cliSkipped } : {}), ...(mcpcSkipped ? { mcpcSkipped } : {}) });
  io.stdout(formatConsole(runs, summary, meta));

  if (out !== undefined) {
    const base = resolve(root, out);
    mkdirSync(dirname(base), { recursive: true });
    writeFileSync(`${base}.md`, formatMarkdown(runs, summary, meta));
    writeFileSync(`${base}.json`, formatJson(runs, summary, meta));
    io.stdout(`wrote ${out}.md and ${out}.json\n`);
  }

  if (runs.every((r) => r.status === 'error')) {
    io.stderr(`every run failed; first error: ${runs[0]?.error ?? 'unknown'}\n`);
    return 1;
  }
  return 0;
}
