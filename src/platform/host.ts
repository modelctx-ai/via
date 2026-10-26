// Which kind of machine via is running on, as far as `via doctor` cares (guides/getting-started.md,
// "Windows"): Windows itself, a WSL distribution, or anything else. Pure: the caller hands in the
// platform, the environment and a reader for `/proc/version`, so every host runs the same tests.

/** `windows`: `process.platform === 'win32'`. `wsl`: Linux under the Windows Subsystem for Linux. */
export type HostKind = 'windows' | 'wsl' | 'other';

export interface HostProbe {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  /** The text of `/proc/version`, or undefined when it cannot be read (not Linux, no procfs). */
  readProcVersion?: () => string | undefined;
}

/**
 * WSL sets `WSL_DISTRO_NAME` (and `WSL_INTEROP` on WSL2) in every shell it starts; a process whose
 * environment was scrubbed still has the kernel's banner in `/proc/version` (`…-microsoft-standard-WSL2`).
 * Either sign is enough; a plain `linux` with neither is `other`.
 */
export function detectHost(probe: HostProbe): HostKind {
  if (probe.platform === 'win32') return 'windows';
  if (probe.platform !== 'linux') return 'other';
  if (probe.env.WSL_DISTRO_NAME || probe.env.WSL_INTEROP) return 'wsl';
  const version = probe.readProcVersion?.();
  if (version !== undefined && /microsoft/i.test(version)) return 'wsl';
  return 'other';
}

/** A path under a WSL drive mount (`/mnt/c/…`): a file on the Windows side, read through the 9P bridge. */
export const WINDOWS_MOUNT = /^\/mnt\/[a-z]\//i;

/** The paths among `paths` that live on the Windows side, in order, without duplicates. */
export function windowsSidePaths(paths: Iterable<string | undefined>): string[] {
  const seen = new Set<string>();
  for (const path of paths) if (path !== undefined && WINDOWS_MOUNT.test(path)) seen.add(path);
  return [...seen];
}
