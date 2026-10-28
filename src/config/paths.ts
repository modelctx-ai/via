import { homedir } from 'node:os';
import path, { isAbsolute, resolve, win32, type PlatformPath } from 'node:path';

export type Env = Readonly<Record<string, string | undefined>>;

/** Everything path resolution depends on, injectable so tests never touch the real home directory. */
export interface PathContext {
  home: string;
  env: Env;
  platform: NodeJS.Platform;
}

export function pathContext(init: Partial<PathContext> = {}): PathContext {
  return { home: init.home ?? homedir(), env: init.env ?? process.env, platform: init.platform ?? process.platform };
}

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

/**
 * `config.yaml` lives in `$XDG_CONFIG_HOME/via` (default `~/.config/via`, also on macOS), or in
 * `%APPDATA%\via` on Windows (config.md).
 */
export function userConfigDir(ctx: PathContext): string {
  const { join } = pathModule(ctx.platform);
  if (ctx.platform === 'win32') return join(getEnv(ctx.env, 'APPDATA', 'win32') || join(ctx.home, 'AppData', 'Roaming'), 'via');
  return join(ctx.env.XDG_CONFIG_HOME || join(ctx.home, '.config'), 'via');
}

/** Where to tell the user to put `config.yaml`, as they would type it (for `next:` hints): `XDG_CONFIG_HOME` moves it. */
export function userConfigHint(ctx: PathContext): string {
  if (ctx.platform === 'win32') return '%APPDATA%\\via\\config.yaml';
  return ctx.env.XDG_CONFIG_HOME ? shortenHome(userConfigPath(ctx), ctx.home, ctx.platform) : '~/.config/via/config.yaml';
}

export function userConfigPath(ctx: PathContext): string {
  return pathModule(ctx.platform).join(userConfigDir(ctx), 'config.yaml');
}

/**
 * User data directory (trust records). Mirrors the `env-paths` data directory for the platform,
 * but takes its inputs from the context instead of `process`.
 */
export function userDataDir(ctx: PathContext): string {
  const { join } = pathModule(ctx.platform);
  if (ctx.platform === 'darwin') return join(ctx.home, 'Library', 'Application Support', 'via');
  if (ctx.platform === 'win32') return join(getEnv(ctx.env, 'LOCALAPPDATA', 'win32') || join(ctx.home, 'AppData', 'Local'), 'via', 'Data');
  return join(ctx.env.XDG_DATA_HOME || join(ctx.home, '.local', 'share'), 'via');
}

/**
 * User cache directory (catalog cache, cursors, media). Mirrors the `env-paths` cache directory
 * for the platform, taking its inputs from the context instead of `process`.
 */
export function userCacheDir(ctx: PathContext): string {
  const { join } = pathModule(ctx.platform);
  if (ctx.platform === 'darwin') return join(ctx.home, 'Library', 'Caches', 'via');
  if (ctx.platform === 'win32') return join(getEnv(ctx.env, 'LOCALAPPDATA', 'win32') || join(ctx.home, 'AppData', 'Local'), 'via', 'Cache');
  return join(ctx.env.XDG_CACHE_HOME || join(ctx.home, '.cache'), 'via');
}

/**
 * Expand a leading `~` and `%NAME%` variables. Returns undefined when a variable is not set,
 * so a Windows-only path is skipped quietly elsewhere.
 */
export function expandPath(input: string, ctx: PathContext): string | undefined {
  const { join } = pathModule(ctx.platform);
  let out = input;
  if (out === '~') out = ctx.home;
  else if (out.startsWith('~/') || out.startsWith('~\\')) out = join(ctx.home, out.slice(2));
  let missing = false;
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, name: string) => {
    const value = getEnv(ctx.env, name, ctx.platform);
    if (!value) missing = true;
    return value ?? '';
  });
  return missing ? undefined : out;
}

/** A path from a config file: `~` expanded, relative paths resolved against `base`. */
export function resolveAgainst(input: string, base: string, ctx: PathContext): string {
  const expanded = expandPath(input, ctx) ?? input;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

/**
 * A Windows path in its plain form: `\\?\` and `\\?\UNC\` prefixes removed, separators normalized,
 * drive letter upper-cased. Pure string work, so it can be tested on any host.
 */
export function normalizeWindowsPath(input: string): string {
  const plain = input.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\[?.]\\(?=[A-Za-z]:)/, '');
  return win32.normalize(plain).replace(/^[a-z]:/, (drive) => drive.toUpperCase());
}

/**
 * Identity of a path for comparisons and de-duplication: normalized, and case-folded on Windows
 * where the file system is case-insensitive (`C:\Users\Me` and `c:/users/me` are one file).
 */
export function pathIdentity(input: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return input;
  return normalizeWindowsPath(input).replace(/[\\/]+$/, '').toLowerCase();
}

/** `~/.cursor/mcp.json` instead of the absolute path, for display. Either separator; case-insensitive on Windows. */
export function shortenHome(input: string, home: string | undefined, platform: NodeJS.Platform = process.platform): string {
  if (!home) return input;
  const base = home.replace(/[\\/]+$/, '');
  const fold = (text: string): string => (platform === 'win32' ? text.toLowerCase() : text);
  if (fold(input.slice(0, base.length)) !== fold(base)) return input;
  const rest = input.slice(base.length);
  if (rest === '') return '~';
  return rest.startsWith('/') || rest.startsWith('\\') ? `~${rest}` : input;
}
