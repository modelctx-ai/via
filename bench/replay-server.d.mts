import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export interface ReplayTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface ReplayResult {
  content: unknown[];
  isError?: boolean;
}

export interface ReplayCall {
  tool: string;
  /** Subset match against the call's arguments; absent matches any arguments. */
  args?: Record<string, unknown>;
  result: ReplayResult;
}

export interface ReplayLogEntry {
  tool: string;
  args: Record<string, unknown>;
  matched: boolean;
}

export interface ReplayOptions {
  name?: string;
  tools: ReplayTool[];
  /** Tried in order, first match wins. Mutable: replacing the contents re-targets a running server. */
  calls?: ReplayCall[];
  /** Every `tools/call` received is appended here. */
  log?: ReplayLogEntry[];
}

export interface TaskLike {
  calls?: ReadonlyArray<{
    server: string;
    tool: string;
    args?: Record<string, unknown>;
    result?: unknown;
    resultFile?: string;
    text?: string;
    textFile?: string;
    content?: unknown[];
    isError?: boolean;
  }>;
}

export declare function readTools(file: string): ReplayTool[];
export declare function readTaskFile(file: string): unknown;
export declare function matchArgs(expected: unknown, actual: unknown): boolean;
export declare function cannedCalls(tasks: TaskLike[], server: string, baseDir: string): ReplayCall[];
export declare function createReplayServer(options: ReplayOptions): Server;
export declare function startReplayHttp(
  options: ReplayOptions & { port?: number; host?: string },
): Promise<{ url: string; log: ReplayLogEntry[]; close(): Promise<void> }>;
