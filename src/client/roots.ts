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
  const expanded = entry === '~' || entry.startsWith('~/') ? join(ctx.home, entry.slice(1)) : entry;
  return pathToFileURL(isAbsolute(expanded) ? resolve(expanded) : resolve(ctx.cwd, expanded)).href;
}

/** What the server is told: the URI and the last path segment as display name. */
export function resolveRoots(entries: readonly string[] | undefined, ctx: RootsContext): Root[] {
  const seen = new Set<string>();
  const roots: Root[] = [];
  for (const entry of entries ?? []) {
    const uri = rootUri(entry, ctx);
    if (seen.has(uri)) continue;
    seen.add(uri);
    let name = '';
    try {
      name = basename(fileURLToPath(uri));
    } catch {
      // not a local file URI (it names a host); the URI is all there is
    }
    roots.push(name === '' ? { uri } : { uri, name });
  }
  return roots;
}
