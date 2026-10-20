// MCP roots (config.md, `roots`; ADR 0010): the directories via tells a server it may work in.
// Paths become `file://` URIs; nothing here touches the disk.
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface Root {
  uri: string;
  name?: string;
}

export interface RootsContext {
  /** Base of relative paths: the working directory of the CLI that asked. */
  cwd: string;
  /** Replaces a leading `~`. */
  home: string;
}

/** One configured entry as an absolute `file://` URI. Idempotent: a URI comes back unchanged. */
export function rootUri(entry: string, ctx: RootsContext): string {
  if (/^file:\/\//i.test(entry)) return entry;
  const expanded = entry === '~' || entry.startsWith('~/') || entry.startsWith('~\\') ? join(ctx.home, entry.slice(1)) : entry;
  return pathToFileURL(isAbsolute(expanded) ? resolve(expanded) : resolve(ctx.cwd, expanded)).href;
}

/**
 * The last path segment of a `file://` URI. `fileURLToPath` is platform-bound: on Windows it refuses
 * a URI without a drive letter (`file:///already/a/uri`) that is perfectly good elsewhere, so the
 * name is then read from the URI path itself. A URI that names another host has no local name.
 */
function rootName(uri: string): string {
  try {
    return basename(fileURLToPath(uri));
  } catch {
    // fall through: not a path of this platform
  }
  try {
    const url = new URL(uri);
    if (url.hostname !== '' && url.hostname.toLowerCase() !== 'localhost') return '';
    return decodeURIComponent(url.pathname).split('/').filter(Boolean).pop() ?? '';
  } catch {
    return '';
  }
}

/** What the server is told: the URI and the last path segment as display name. */
export function resolveRoots(entries: readonly string[] | undefined, ctx: RootsContext): Root[] {
  const seen = new Set<string>();
  const roots: Root[] = [];
  for (const entry of entries ?? []) {
    const uri = rootUri(entry, ctx);
    if (seen.has(uri)) continue;
    seen.add(uri);
    const name = rootName(uri);
    roots.push(name === '' ? { uri } : { uri, name });
  }
  return roots;
}
