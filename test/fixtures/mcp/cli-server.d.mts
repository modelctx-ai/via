import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export interface CliState {
  tools: Array<Record<string, unknown> & { name: string }>;
  listCalls: number;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  /** `sleepy` calls running right now, and the most that ever ran together. */
  inflight: number;
  maxInflight: number;
}
export declare function defaultTools(): CliState['tools'];
export declare function createCliState(): CliState;
export declare function createCliServer(options: { state: CliState; authorization?: string }): Server;
