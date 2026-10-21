import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Server as ModernServer } from '@modelcontextprotocol/server';

export interface CliState {
  tools: Array<Record<string, unknown> & { name: string }>;
  listCalls: number;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  /** `sleepy` calls running right now, and the most that ever ran together. */
  inflight: number;
  maxInflight: number;
  /** URIs of `resources/read` requests, and `prompts/get` requests, in order. */
  reads: string[];
  prompts: Array<{ name: string; args: Record<string, string> }>;
  /** Replaces the prompts the server lists, when set. */
  promptList?: Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }> | undefined;
}
export declare function defaultTools(): CliState['tools'];
export declare function createCliState(): CliState;
type Options = { state: CliState; authorization?: string; features?: Array<'resources' | 'prompts' | 'roots'> };
/** `flavor` picks the protocol generation: `legacy` (initialize handshake, the default) or `modern` (stateless `2026-07-28`). */
export declare function createCliServer(options: Options & { flavor: 'modern'; notifier?: { toolsChanged(): void }; /** `ttlMs` of `tools/list` results. */ ttlMs?: number }): ModernServer;
export declare function createCliServer(options: Options & { flavor?: 'legacy' }): Server;
