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
  /** `auth.oauth.issuer` set by a non-project layer (user config, user-level framework config, CLI); project layers cannot override it. */
  userIssuerPin?: string;
  /** Layer that last wrote each credential-bearing field: `auth`, `headers.<name>`, `env.<name>` (`ServerConfig.refOrigins`). */
  refOrigins: Map<string, ConfigOrigin>;
}

export function newAccumulator(): Accumulator {
  return { def: {}, launch: new Map(), refOrigins: new Map() };
}

/** Forget where the fields under `prefix` (`headers.`, `env.`) came from: a layer replaced the transport that had them. */
function dropOrigins(acc: Accumulator, prefix: string): void {
  for (const key of [...acc.refOrigins.keys()]) if (key.startsWith(prefix)) acc.refOrigins.delete(key);
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
    dropOrigins(acc, 'headers.');
  }
  if (def.url !== undefined && d.command !== undefined) {
    delete d.command;
    delete d.args;
    delete d.env;
    delete d.cwd;
    acc.launch.clear();
    dropOrigins(acc, 'env.');
  }
  if (def.command !== undefined) d.command = def.command;
  if (def.url !== undefined) d.url = def.url;
  if (def.command !== undefined || def.url !== undefined) acc.transportOrigin = origin;

  if (def.args !== undefined) d.args = [...def.args];
  if (def.cwd !== undefined) d.cwd = def.cwd;
  if (def.env !== undefined) {
    d.env = mergeRecord(d.env, def.env);
    for (const key of Object.keys(def.env)) acc.refOrigins.set(`env.${key}`, origin);
  }
  if (def.headers !== undefined) {
    d.headers = mergeRecord(d.headers, def.headers);
    for (const key of Object.keys(def.headers)) acc.refOrigins.set(`headers.${key}`, origin);
  }
  if (def.rename !== undefined) d.rename = mergeRecord(d.rename, def.rename);
  if (def.noise !== undefined) d.noise = [...new Set([...(d.noise ?? []), ...def.noise])];
  if (def.roots !== undefined) d.roots = [...def.roots];
  if (def.auth !== undefined) {
    let auth = def.auth as AuthConfig;
    if (isProject(origin)) {
      // A pin from the user's own config (or the CLI) stays: a project file may add one where there is none, but
      // not change or drop the user's (security.md, "钉住授权服务器"). It cannot make a pin looser, only the user can.
      if (auth.type === 'oauth' && acc.userIssuerPin !== undefined) auth = { ...auth, issuer: acc.userIssuerPin };
    } else {
      acc.userIssuerPin = auth.type === 'oauth' ? auth.issuer : undefined;
    }
    d.auth = auth;
    acc.refOrigins.set('auth', origin);
  }
  // `confirm.tools` only adds; `confirm.except` and `confirm: never` loosen, so load.ts strips them from project layers.
  if (def.confirmTools !== undefined) d.confirmTools = [...new Set([...(d.confirmTools ?? []), ...def.confirmTools])];
  if (def.confirmExcept !== undefined) d.confirmExcept = [...new Set([...(d.confirmExcept ?? []), ...def.confirmExcept])];
  for (const key of ['alias', 'disabled', 'exclusive', 'confirm', 'timeout', 'concurrency', 'budget', 'protocolVersion'] as const) {
    if (def[key] !== undefined) (d as Record<string, unknown>)[key] = def[key];
  }

  // Non-empty `roots` widens what the server may touch, so it is trusted like a command (security.md); `[]` only narrows.
  const widensRoots = def.roots !== undefined && def.roots.length > 0;
  if (isProject(origin) && origin.path && (widensRoots || [def.command, def.args, def.env, def.cwd, def.url, def.headers].some((v) => v !== undefined))) {
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
