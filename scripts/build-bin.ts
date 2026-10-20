// Build the single-file executable(s): `bun scripts/build-bin.ts [--all | --target <name>[,<name>]]`
// (`npm run build:bin`). Output: dist/bin/via-<os>-<arch>[-musl][.exe] and a `.sha256` next to each.
//
// Compiled from src/, not from the tsup output: Bun bundles the same code itself, and the
// `@napi-rs/keyring` import can be pointed at the right platform's `.node` file, which is how a
// cross-compiled binary gets the keychain module of its own target (implementation.md, "单文件可执行").
//
//   --all             every target in scripts/lib/bin-targets.ts (cross-compiles; downloads Bun runtimes)
//   --target a,b      the named targets
//   --out-dir <dir>   default dist/bin
//   --no-bytecode     skip bytecode (only useful to compare start-up time: 3x slower without it)
//
// Needs Bun >= 1.3 on the build machine and, for any target other than the host, network access
// (the target's Bun runtime and its @napi-rs/keyring-<platform> package from the npm registry).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binaryName, hostTarget, keyringStub, lockedKeyring, matchesIntegrity, TARGETS, targetByName, type BinTarget } from './lib/bin-targets';

/** The slice of the Bun API used here (the repo does not depend on bun-types). */
declare const Bun:
  | {
      version: string;
      build(options: Record<string, unknown>): Promise<{ success: boolean; logs: Array<{ message: string }>; outputs: Array<{ path: string }> }>;
    }
  | undefined;

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function fail(message: string): never {
  process.stderr.write(`build-bin: ${message}\n`);
  process.exit(1);
}

function isMusl(): boolean {
  try {
    return readdirSync('/lib').some((f) => f.startsWith('ld-musl-'));
  } catch {
    return false;
  }
}

/** Absolute path of the target's `keyring.<platform>.node`, fetched and verified against package-lock.json when it is not installed. */
function nativeModule(target: BinTarget): string {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as unknown;
  const pinned = lockedKeyring(lock, target);
  const file = `keyring.${target.keyring}.node`;
  const installed = join(ROOT, 'node_modules', pinned.name, file);
  const installedVersion = existsSync(installed) ? (JSON.parse(readFileSync(join(ROOT, 'node_modules', pinned.name, 'package.json'), 'utf8')) as { version: string }).version : undefined;
  if (installedVersion === pinned.version) return installed;

  const cache = join(ROOT, '.build', 'native', `${target.keyring}-${pinned.version}`);
  const cached = join(cache, file);
  if (existsSync(cached)) return cached;

  const scratch = mkdtempSync(join(ROOT, '.build', 'pack-'));
  try {
    // `npm pack` honours the user's registry, proxy and auth settings.
    const pack = spawnSync('npm', ['pack', `${pinned.name}@${pinned.version}`, '--pack-destination', scratch, '--silent'], { cwd: scratch, encoding: 'utf8', shell: process.platform === 'win32' });
    if (pack.status !== 0) fail(`cannot download ${pinned.name}@${pinned.version}: ${(pack.stderr || pack.stdout).trim().split('\n')[0]}`);
    const tarball = join(scratch, readdirSync(scratch).find((f) => f.endsWith('.tgz')) ?? fail(`npm pack produced no tarball for ${pinned.name}`));
    if (!matchesIntegrity(readFileSync(tarball), pinned.integrity)) fail(`${pinned.name}@${pinned.version} does not match the integrity in package-lock.json`);
    mkdirSync(cache, { recursive: true });
    const untar = spawnSync('tar', ['-xzf', tarball, '-C', cache, '--strip-components=1', `package/${file}`], { encoding: 'utf8' });
    if (untar.status !== 0 || !existsSync(cached)) fail(`cannot extract ${file} from ${pinned.name}: ${untar.stderr.trim()}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return cached;
}

async function build(target: BinTarget, outDir: string, bytecode: boolean): Promise<string> {
  if (Bun === undefined) fail('run this script with Bun: `bun scripts/build-bin.ts`');
  const nodeFile = nativeModule(target);
  const stub = keyringStub(nodeFile);
  const outfile = join(outDir, binaryName(target));
  const result = await Bun.build({
    entrypoints: [join(ROOT, 'src', 'cli', 'main.ts')],
    // Real chunks keep the lazy loading of the npm build: `--version` does not touch the command runner.
    splitting: true,
    format: 'esm',
    minify: true,
    sourcemap: 'none',
    bytecode,
    // Only the Bun runtime of the executable matters; a .env or bunfig.toml in the current directory
    // must not change how via reads its environment.
    compile: { target: target.bun, outfile, autoloadDotenv: false, autoloadBunfig: false },
    plugins: [
      {
        name: 'via-keyring',
        setup(build: { onResolve(o: { filter: RegExp }, cb: () => unknown): void; onLoad(o: { filter: RegExp; namespace: string }, cb: () => unknown): void }) {
          build.onResolve({ filter: /^@napi-rs\/keyring$/ }, () => ({ path: 'keyring', namespace: 'via-keyring' }));
          build.onLoad({ filter: /.*/, namespace: 'via-keyring' }, () => ({ contents: stub, loader: 'js' }));
        },
      },
    ],
  });
  if (!result.success) fail(`bun build failed for ${target.name}:\n${result.logs.map((l) => `  ${l.message}`).join('\n')}`);
  const digest = createHash('sha256').update(readFileSync(outfile)).digest('hex');
  writeFileSync(`${outfile}.sha256`, `${digest}  ${binaryName(target)}\n`);
  return outfile;
}

const args = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] ?? fail(`${flag} needs a value`) : undefined;
};
for (const arg of args) if (arg.startsWith('-') && !['--all', '--target', '--out-dir', '--no-bytecode'].includes(arg)) fail(`unknown option ${arg}`);

const outDir = resolve(ROOT, value('--out-dir') ?? join('dist', 'bin'));
const targets = args.includes('--all') ? [...TARGETS] : (value('--target')?.split(',').map(targetByName) ?? [hostTarget(process.platform, process.arch, isMusl())]);
mkdirSync(outDir, { recursive: true });
mkdirSync(join(ROOT, '.build'), { recursive: true });
for (const target of targets) {
  const started = Date.now();
  const file = await build(target, outDir, !args.includes('--no-bytecode'));
  process.stdout.write(`${target.name}: ${file} (${((readFileSync(file).length) / 1048576).toFixed(1)} MiB, ${Date.now() - started} ms)\n`);
}
