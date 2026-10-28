// Platform facts every layer needs without depending on configuration: how environment variables
// are looked up and which path module builds strings for a platform (implementation.md, "Windows 约定").
import path, { win32, type PlatformPath } from 'node:path';

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * The path module for building strings for `platform`: `win32` semantics when a Windows platform
 * is injected (so tests on any host get backslashes, drive letters and UNC paths), the host's own
 * module otherwise. A Windows host given `linux` keeps using its own module on purpose: the
 * directories it is handed are real Windows paths. Only for pure string construction; anything
 * that goes on to touch the file system uses the host module.
 */
export function pathModule(platform: NodeJS.Platform): PlatformPath {
  return platform === 'win32' ? win32 : path;
}

/**
 * Environment variable lookup. Names are case-insensitive on Windows (`Path`, `PATH`, `SystemRoot`),
 * which a plain object injected by a test or built by `baseEnvironment` does not model; the real
 * `process.env` already does.
 */
export function getEnv(env: Env, name: string, platform: NodeJS.Platform): string | undefined {
  const direct = env[name];
  if (direct !== undefined || platform !== 'win32') return direct;
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) if (key.toLowerCase() === lower) return env[key];
  return undefined;
}
