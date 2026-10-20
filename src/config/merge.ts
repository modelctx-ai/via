// Merging server definitions across sources (config.md, "合并规则"): framework configs in `sources`
// order, then user, project and CLI overrides, deep-merged field by field by server name.

import type { ServerDef } from './model';
import type { AuthConfig, ConfigOrigin } from './types';

/** What has been merged so far for one server. */
export interface Accumulator {
  def: ServerDef;
  /** Origin of the layer that last set `command` or `url`. */
  transportOrigin?: ConfigOrigin;
  /**
   * Project-scoped files that shape the transport: how a stdio process is launched (command, args,
   * env, cwd) or where HTTP requests go and what they carry (url, headers).
   */
  launch: Map<string, ConfigOrigin>;
}

export function newAccumulator(): Accumulator {
  return { def: {}, launch: new Map() };
}

function mergeRecord(base: Record<string, string> | undefined, overlay: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of [base ?? {}, overlay]) {
    for (const [key, value] of Object.entries(source)) {
      Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
    }
  }
  return out;
}

const isProject = (origin: ConfigOrigin): boolean => origin.scope === 'project' || origin.scope === 'framework-project';

/**
 * Apply one layer on top of the accumulator. A layer that names a different transport (`command`
 * over an HTTP server or `url` over a stdio one) replaces the transport and drops the other
 * transport's fields; everything else is merged by key.
 */
export function applyDef(acc: Accumulator, def: ServerDef, origin: ConfigOrigin): void {
  const d = acc.def;
  if (def.command !== undefined && d.url !== undefined) {
    delete d.url;
    delete d.headers;
    acc.launch.clear();
  }
  if (def.url !== undefined && d.command !== undefined) {
    delete d.command;
    delete d.args;
    delete d.env;
    delete d.cwd;
    acc.launch.clear();
  }
  if (def.command !== undefined) d.command = def.command;
  if (def.url !== undefined) d.url = def.url;
  if (def.command !== undefined || def.url !== undefined) acc.transportOrigin = origin;

  if (def.args !== undefined) d.args = [...def.args];
  if (def.cwd !== undefined) d.cwd = def.cwd;
  if (def.env !== undefined) d.env = mergeRecord(d.env, def.env);
  if (def.headers !== undefined) d.headers = mergeRecord(d.headers, def.headers);
  if (def.rename !== undefined) d.rename = mergeRecord(d.rename, def.rename);
  if (def.noise !== undefined) d.noise = [...new Set([...(d.noise ?? []), ...def.noise])];
  if (def.auth !== undefined) d.auth = def.auth as AuthConfig;
  for (const key of ['alias', 'domain', 'disabled', 'exclusive', 'confirm', 'timeout', 'concurrency', 'budget'] as const) {
    if (def[key] !== undefined) (d as Record<string, unknown>)[key] = def[key];
  }

  if (isProject(origin) && origin.path && [def.command, def.args, def.env, def.cwd, def.url, def.headers].some((v) => v !== undefined)) {
    acc.launch.set(origin.path, origin);
  }
}

/** Key-sorted JSON, for comparing two definitions of the same server. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}
