import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

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
 * `config.yaml` lives in `$XDG_CONFIG_HOME/via` (default `~/.config/via`, also on macOS), or in
 * `%APPDATA%\via` on Windows (config.md).
 */
export function userConfigDir(ctx: PathContext): string {
  if (ctx.platform === 'win32') return join(ctx.env.APPDATA || join(ctx.home, 'AppData', 'Roaming'), 'via');
  return join(ctx.env.XDG_CONFIG_HOME || join(ctx.home, '.config'), 'via');
}

export function userConfigPath(ctx: PathContext): string {
  return join(userConfigDir(ctx), 'config.yaml');
}

/**
 * User data directory (trust records). Mirrors the `env-paths` data directory for the platform,
 * but takes its inputs from the context instead of `process`.
 */
export function userDataDir(ctx: PathContext): string {
  if (ctx.platform === 'darwin') return join(ctx.home, 'Library', 'Application Support', 'via');
  if (ctx.platform === 'win32') return join(ctx.env.LOCALAPPDATA || join(ctx.home, 'AppData', 'Local'), 'via', 'Data');
  return join(ctx.env.XDG_DATA_HOME || join(ctx.home, '.local', 'share'), 'via');
}

/**
 * User cache directory (catalog cache, cursors, media). Mirrors the `env-paths` cache directory
 * for the platform, taking its inputs from the context instead of `process`.
 */
export function userCacheDir(ctx: PathContext): string {
  if (ctx.platform === 'darwin') return join(ctx.home, 'Library', 'Caches', 'via');
  if (ctx.platform === 'win32') return join(ctx.env.LOCALAPPDATA || join(ctx.home, 'AppData', 'Local'), 'via', 'Cache');
  return join(ctx.env.XDG_CACHE_HOME || join(ctx.home, '.cache'), 'via');
}

/**
 * Expand a leading `~` and `%NAME%` variables. Returns undefined when a variable is not set,
 * so a Windows-only path is skipped quietly elsewhere.
 */
export function expandPath(path: string, ctx: PathContext): string | undefined {
  let out = path;
  if (out === '~') out = ctx.home;
  else if (out.startsWith('~/') || out.startsWith('~\\')) out = join(ctx.home, out.slice(2));
  let missing = false;
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, name: string) => {
    const value = ctx.env[name];
    if (!value) missing = true;
    return value ?? '';
  });
  return missing ? undefined : out;
}

/** A path from a config file: `~` expanded, relative paths resolved against `base`. */
export function resolveAgainst(path: string, base: string, ctx: PathContext): string {
  const expanded = expandPath(path, ctx) ?? path;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}
