// Platforms the single-file executable is built for, and the pure helpers around them. No Bun API
// here, so vitest (Node) can test it; the build itself is scripts/build-bin.ts.
import { createHash } from 'node:crypto';

export interface BinTarget {
  /** `<os>-<arch>[-musl]`, the suffix of the file name. */
  name: string;
  /** `--target` value of `bun build --compile`. */
  bun: string;
  /** Suffix of the `@napi-rs/keyring-<suffix>` package that holds this platform's `.node` file. */
  keyring: string;
  windows: boolean;
}

export const TARGETS: readonly BinTarget[] = [
  { name: 'linux-x64', bun: 'bun-linux-x64', keyring: 'linux-x64-gnu', windows: false },
  { name: 'linux-arm64', bun: 'bun-linux-arm64', keyring: 'linux-arm64-gnu', windows: false },
  { name: 'linux-x64-musl', bun: 'bun-linux-x64-musl', keyring: 'linux-x64-musl', windows: false },
  { name: 'linux-arm64-musl', bun: 'bun-linux-arm64-musl', keyring: 'linux-arm64-musl', windows: false },
  { name: 'darwin-x64', bun: 'bun-darwin-x64', keyring: 'darwin-x64', windows: false },
  { name: 'darwin-arm64', bun: 'bun-darwin-arm64', keyring: 'darwin-arm64', windows: false },
  { name: 'windows-x64', bun: 'bun-windows-x64', keyring: 'win32-x64-msvc', windows: true },
];

/** File name of a target's binary: `via-linux-x64`, `via-windows-x64.exe`. */
export function binaryName(target: BinTarget): string {
  return `via-${target.name}${target.windows ? '.exe' : ''}`;
}

export function targetByName(name: string): BinTarget {
  const found = TARGETS.find((t) => t.name === name);
  if (!found) throw new Error(`unknown target "${name}"; choose from: ${TARGETS.map((t) => t.name).join(', ')}`);
  return found;
}

/** The target for the machine running the build. */
export function hostTarget(platform: string = process.platform, arch: string = process.arch, musl = false): BinTarget {
  const os = platform === 'win32' ? 'windows' : platform;
  const cpu = arch === 'x64' || arch === 'arm64' ? arch : undefined;
  const name = cpu === undefined ? undefined : `${os}-${cpu}${os === 'linux' && musl ? '-musl' : ''}`;
  const found = TARGETS.find((t) => t.name === name);
  if (!found) throw new Error(`no executable target for ${platform}/${arch}; choose one with --target (${TARGETS.map((t) => t.name).join(', ')})`);
  return found;
}

/** What package-lock.json pins for one of the keyring platform packages. */
export interface LockedPackage {
  name: string;
  version: string;
  resolved: string;
  integrity: string;
}

export function lockedKeyring(lock: unknown, target: BinTarget): LockedPackage {
  const name = `@napi-rs/keyring-${target.keyring}`;
  const entry = (lock as { packages?: Record<string, { version?: string; resolved?: string; integrity?: string }> }).packages?.[`node_modules/${name}`];
  if (!entry?.version || !entry.resolved || !entry.integrity) throw new Error(`package-lock.json does not pin ${name}; run \`npm install\` on a machine that can resolve optional dependencies`);
  return { name, version: entry.version, resolved: entry.resolved, integrity: entry.integrity };
}

/** Check bytes against an npm `integrity` string (`sha512-<base64>`; the first supported algorithm decides). */
export function matchesIntegrity(data: Uint8Array, integrity: string): boolean {
  for (const part of integrity.split(/\s+/)) {
    const [algorithm, expected] = part.split('-', 2);
    if (algorithm !== 'sha512' && algorithm !== 'sha384' && algorithm !== 'sha256') continue;
    return createHash(algorithm).update(data).digest('base64') === expected;
  }
  return false;
}

/**
 * Module the build substitutes for `@napi-rs/keyring`. It requires the target's `.node` file by
 * literal path, which is what makes Bun embed it into the executable (and extract it on first use).
 * `NAPI_RS_NATIVE_LIBRARY_PATH` keeps its napi-rs meaning: load that file instead of the embedded one.
 */
export function keyringStub(nodeFile: string): string {
  return [
    'const override = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;',
    `const binding = override ? require(override) : require(${JSON.stringify(nodeFile)});`,
    'module.exports = binding;',
    ...['AsyncEntry', 'Entry', 'findCredentials', 'findCredentialsAsync', 'LinuxStore'].map((name) => `module.exports.${name} = binding.${name};`),
    '',
  ].join('\n');
}
