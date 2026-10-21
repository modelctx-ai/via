import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Server as ModernServer } from '@modelcontextprotocol/server';

type State = { active: number; maxActive: number; extra: Array<Record<string, unknown>> };

export declare const TOOLS: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
export declare function createState(): State;
/** `flavor` picks the protocol generation: `legacy` (initialize handshake, the default) or `modern` (stateless `2026-07-28`). */
export declare function createMockServer(options: { pageSize?: number; state?: State; flavor: 'modern'; notifier?: { toolsChanged(): void }; /** `ttlMs` of `tools/list` results. */ ttlMs?: number }): ModernServer;
export declare function createMockServer(options?: { pageSize?: number; state?: State; flavor?: 'legacy' }): Server;
