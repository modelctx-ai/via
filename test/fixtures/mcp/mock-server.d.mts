import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export declare const TOOLS: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
export declare function createState(): { active: number; maxActive: number; extra: Array<Record<string, unknown>> };
export declare function createMockServer(options?: { pageSize?: number; state?: { active: number; maxActive: number; extra: Array<Record<string, unknown>> } }): Server;
