// Token benchmark (testing.md, "token 基准"): native MCP injection vs `via` vs mcp2cli on the
// scripted tasks in bench/. Runs the built CLI (`npm run build` first) against local replay
// servers, offline. Run with `npm run bench:tokens`; see bench/README.md for the options.
//
//   --task <text>      run only the tasks whose id contains this text (repeatable)
//   --via <path>       the built CLI (default dist/via.js)
//   --mcp2cli <path>   mcp2cli executable (default: `mcp2cli` on PATH)
//   --no-mcp2cli       skip the mcp2cli column
//   --show             print every command and its output to stderr (for writing tasks)
//   --out <base>       write <base>.md and <base>.json
//   --release <label>  label in the markdown title (default: dev)
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadSuite } from '../bench/harness/load';
import { spawnExec } from '../bench/harness/exec';
import { measureSuite, type RunnerFactory } from '../bench/harness/measure';
import { formatConsole, formatJson, formatMarkdown, type ReportMeta } from '../bench/harness/report';

interface Options {
  tasks: string[];
  via: string;
  mcp2cli: string | false;
  show: boolean;
  out?: string;
  release: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { tasks: [], via: 'dist/via.js', mcp2cli: 'mcp2cli', show: false, release: 'dev' };
  const value = (i: number): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${argv[i]} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--task') options.tasks.push(value(i++));
    else if (arg === '--via') options.via = value(i++);
    else if (arg === '--mcp2cli') options.mcp2cli = value(i++);
    else if (arg === '--no-mcp2cli') options.mcp2cli = false;
    else if (arg === '--show') options.show = true;
    else if (arg === '--out') options.out = value(i++);
    else if (arg === '--release') options.release = value(i++);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const BASE_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };

/** `mcp2cli --version` → the version, or the reason it cannot run. */
async function probeMcp2cli(bin: string): Promise<{ version: string } | { skipped: string }> {
  try {
    const result = await spawnExec(bin, [], { cwd: process.cwd(), env: BASE_ENV, timeoutMs: 30_000 })(['--version']);
    const match = /(\d+\.\d+\.\d+\S*)/.exec(result.stdout + result.stderr);
    if (result.code === 0 && match) return { version: match[1]! };
    return { skipped: `\`${bin} --version\` failed (exit ${result.code})` };
  } catch {
    return { skipped: `\`${bin}\` not found on PATH (install: uv tool install mcp2cli==<version in bench/suite.yaml>)` };
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  if (!existsSync(resolve(root, 'bench/suite.yaml'))) throw new Error('run from the repository root (bench/suite.yaml not found)');
  const viaBin = resolve(root, options.via);
  if (!existsSync(viaBin)) throw new Error(`${options.via} not found; run \`npm run build\` first`);

  const loaded = loadSuite(root, options.tasks);

  let mcp2cli: { bin: string; version: string } | undefined;
  let mcp2cliSkipped: string | undefined;
  if (options.mcp2cli === false) {
    mcp2cliSkipped = 'disabled with --no-mcp2cli';
  } else {
    const probe = await probeMcp2cli(options.mcp2cli);
    if ('version' in probe) {
      mcp2cli = { bin: options.mcp2cli, version: probe.version };
      if (probe.version !== loaded.suite.mcp2cli.version) {
        process.stderr.write(`note: mcp2cli ${probe.version} is installed, the vendored skill is from ${loaded.suite.mcp2cli.version}\n`);
      }
    } else {
      mcp2cliSkipped = probe.skipped;
    }
  }

  const runners: RunnerFactory = (sandbox) => ({
    via: spawnExec(process.execPath, [viaBin], { cwd: sandbox.project, env: sandbox.env }),
    ...(mcp2cli
      ? {
          mcp2cli: {
            exec: spawnExec(mcp2cli.bin, [], { cwd: sandbox.project, env: sandbox.env }),
            version: mcp2cli.version,
            prepare: async (urls) => {
              const run = spawnExec(mcp2cli!.bin, [], { cwd: sandbox.project, env: sandbox.env });
              for (const [name, url] of Object.entries(urls)) {
                const result = await run(['bake', 'create', name, '--mcp', url]);
                if (result.code !== 0) throw new Error(`mcp2cli bake create ${name} failed: ${result.stderr || result.stdout}`);
              }
            },
          },
        }
      : {}),
  });

  const measure = await measureSuite({ loaded, runners, log: (line) => process.stderr.write(`${line}\n`),
    ...(options.show
      ? { trace: (label: string, command: string, stdout: string, stderr: string) => process.stderr.write(`\n[${label}] $ ${command}\n${stdout}${stderr ? `--- stderr\n${stderr}` : ''}`) }
      : {}),
  });

  const version = (await spawnExec(process.execPath, [viaBin], { cwd: root, env: BASE_ENV })(['--version'])).stdout.trim();
  const meta: ReportMeta = {
    via: version,
    node: process.version,
    mounted: loaded.suite.mounted,
    ...(mcp2cliSkipped ? { mcp2cliSkipped } : {}),
  };
  process.stdout.write(formatConsole(measure, meta));

  if (options.out) {
    const base = resolve(root, options.out);
    mkdirSync(dirname(base), { recursive: true });
    writeFileSync(`${base}.md`, formatMarkdown(measure, meta, options.release));
    writeFileSync(`${base}.json`, formatJson(measure, meta));
    process.stdout.write(`wrote ${options.out}.md and ${options.out}.json\n`);
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`bench:tokens: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
