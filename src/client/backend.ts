// The interface every way of reaching MCP servers implements (daemon.md): the in-process and fallback
// backends (cli/backend.ts) and the daemon's socket backend (daemon/backend.ts). Types only.
import type { McpTool } from '../catalog/types';
import type { McpClient } from './client';
import type { ServerConfig } from '../config/types';
import type { ProtocolInfo, ServerFeatures } from '../protocol';
import type { CursorStore } from '../render/cursor';
import type { SchemaCompiler } from '../schema/validate';

/** A fetched `tools/list` and where it came from. */
export interface Listing {
  /** For a list read from the disk cache this parses on first access, not before. */
  readonly tools: McpTool[];
  fetchedAt: number;
  fromCache: boolean;
  /**
   * Length of the text of the cache file the list is (or was just written to), when there is one.
   * Together with `fetchedAt` it identifies the content without parsing it (view-cache.ts).
   */
  rawBytes?: number;
  /** Resources and prompts the server declared; absent when not known (an older cache entry). */
  features?: ServerFeatures;
  /** The protocol the list was fetched over; absent when not known (an older cache entry). */
  protocol?: ProtocolInfo;
}

export interface ListingOptions {
  /** Per-request ceiling in milliseconds. */
  timeoutMs: number;
  /**
   * Discovery commands (`via`, `via find`, `via prompt`): a daemon answers after at most `waitMs` and
   * keeps connecting up to `timeoutMs` in the background, writing the cache; a server that has not
   * finished by then fails with a `timeout` error (the provider is `starting`). A backend that has
   * nothing behind it (in-process) ignores this and stops at `timeoutMs`.
   */
  background?: { waitMs: number; timeoutMs: number };
  /** Skip the cache and ask the server (`via sync`, `via doctor`). */
  refresh?: boolean;
  /**
   * The `fetchedAt` of a list the caller holds a build of (view-cache.ts). A backend that has to
   * move the tools between processes may then leave them out when its list is that one; the
   * returned listing is the same either way.
   */
  have?: number;
}

/**
 * What the commands need from "the thing that talks to MCP servers". `McpClient` (raw `listTools`,
 * `callTool`, `close`) stays the base so code written against the in-process client keeps working;
 * the rest is what a command needs around it. Failures are thrown as `ClientError`.
 */
export interface Backend extends McpClient {
  readonly mode: 'daemon' | 'in-process';
  /**
   * The tools of one server: the cache when it is fresh, else the server (and then cached). A missing
   * credential fails before any network call. `server` is the definition from the configuration.
   */
  listing(server: ServerConfig, options: ListingOptions): Promise<Listing>;
  /** Schema compiler for local argument validation, or undefined for ajv in this process. */
  compiler(): SchemaCompiler | undefined;
  /** Where the full text of truncated results is kept. */
  cursors(): CursorStore;
  /** Text the CLI composed, scanned for the credential values this backend has resolved (long ones only; see `Redactor.scan`). */
  redact(text: string): Promise<string>;
  /** Content the CLI echoes (dry-run arguments): every string value redacted, the shape kept. */
  redactValue<T>(value: T): Promise<T>;
  /** Credential values known to this process, for rendering. Empty when the daemon holds them. */
  secrets(): readonly string[];
}
