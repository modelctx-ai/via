// Contract between config/ and client/ (config.md, auth.md, security.md).
// config/ produces ServerConfig values and a CredentialResolver; client/
// consumes them. Credential references stay unresolved here: they are only
// resolved in memory right before a connection is made.

/** A credential reference (`env:NAME`, `file:~/x`, `keychain:svc/acct`, `cmd:…`) or a literal value. */
export type CredentialRef = string;

/** Where a server definition (or a field override) came from. */
export type ConfigScope = "framework-user" | "framework-project" | "user" | "project" | "cli";

export interface ConfigOrigin {
  scope: ConfigScope;
  /** Absolute path of the file the definition came from; absent for `cli`. */
  path?: string;
  /** Framework id from `data/frameworks/<id>.json`, for framework sources. */
  framework?: string;
}

/** `servers.<name>.auth` (auth.md). */
export type AuthConfig =
  | { type: "none" }
  | { type: "bearer"; bearer: CredentialRef }
  | { type: "headers"; headers: Record<string, CredentialRef> }
  | { type: "oauth"; scopes?: string[]; clientId?: string };

export interface StdioTransport {
  type: "stdio";
  command: string;
  args: string[];
  /** Values may be credential references. */
  env: Record<string, CredentialRef>;
  cwd?: string;
}

export interface HttpTransport {
  type: "http";
  url: string;
  /** Values may be credential references. */
  headers: Record<string, CredentialRef>;
}

export type Transport = StdioTransport | HttpTransport;

/** One server after all sources are merged (config.md, "合并规则"). */
export interface ServerConfig {
  /** Key under `servers`. */
  name: string;
  /** Provider name used on the command line; defaults to `name`. */
  provider: string;
  transport: Transport;
  auth: AuthConfig;
  domain?: string;
  rename: Record<string, string>;
  disabled: boolean;
  exclusive: boolean;
  confirm: "destructive" | "never";
  /** Call timeout in seconds; default 60. */
  timeout: number;
  /** Concurrent requests per server; default 4. */
  concurrency: number;
  budget?: number;
  noise: string[];
  /** Source of the transport definition. */
  origin: ConfigOrigin;
  /**
   * False when the stdio command comes from a project-scoped source that has
   * not been confirmed with `via trust` (security.md). Always true for HTTP.
   */
  trusted: boolean;
  /** Set when framework configs define this name differently; lists the ignored sources. */
  conflicts?: ConfigOrigin[];
}

/** Thrown (or returned) when a credential reference cannot be resolved. Exit code 4. */
export class CredentialError extends Error {
  constructor(
    message: string,
    /** The reference that failed, e.g. `env:EXA_KEY` — never a resolved value. */
    readonly ref: CredentialRef,
    /** Suggested next step for the `next:` line. */
    readonly next?: string,
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

/** Resolves credential references in memory. Implementations must never write results to disk. */
export interface CredentialResolver {
  /**
   * Resolve one reference. Values without a known prefix are returned as literals.
   * Throws CredentialError when the reference cannot be resolved.
   */
  resolve(ref: CredentialRef, origin: ConfigOrigin): Promise<string>;
  /** Every value resolved so far, for redaction (output.md, "脱敏"). */
  resolvedValues(): readonly string[];
}
