// The native-MCP column: what a framework puts in front of the model when servers are mounted
// directly. Nothing here is estimated by hand: tool definitions come from the replay servers'
// `tools/list` and results from their `tools/call`, through the official SDK client.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ReplayTool } from '../replay-server.mjs';
import { bytesOf } from './tokens';
import type { Task } from './types';

/** Frameworks namespace MCP tools as `mcp__<server>__<tool>` (the Claude Code convention). */
export const nativeToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`;

/**
 * One tool as it is presented to the model: name, description and input schema (the Anthropic
 * `tools` entry; OpenAI's `function` wrapper adds a few bytes). Annotations are not shown to the
 * model, so they are not counted.
 */
export function injectedTool(server: string, tool: ReplayTool): Record<string, unknown> {
  return { name: nativeToolName(server, tool.name), description: tool.description ?? '', input_schema: tool.inputSchema };
}

export interface InjectionMeasure {
  /** Bytes of the serialized `tools` array for all mounted servers; paid on every turn. */
  bytes: number;
  perServer: Record<string, { tools: number; bytes: number }>;
}

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'via-bench-native', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** `tools/list` of every mounted server, serialized the way a framework injects it. */
export async function measureInjection(urls: Readonly<Record<string, string>>): Promise<InjectionMeasure> {
  const all: Array<Record<string, unknown>> = [];
  const perServer: InjectionMeasure['perServer'] = {};
  for (const [server, url] of Object.entries(urls)) {
    const tools = await withClient(url, async (client) => (await client.listTools()).tools as ReplayTool[]);
    const injected = tools.map((t) => injectedTool(server, t));
    perServer[server] = { tools: tools.length, bytes: bytesOf(JSON.stringify(injected)) };
    all.push(...injected);
  }
  return { bytes: bytesOf(JSON.stringify(all)), perServer };
}

export interface NativeMeasure {
  /** Model turns: one per round of tool calls, plus the final answer. */
  turns: number;
  /** Bytes of the tool-call blocks the model writes. */
  callBytes: number;
  /** Bytes of the raw, unrendered results. */
  resultBytes: number;
  calls: Array<{ tool: string; callBytes: number; resultBytes: number }>;
}

/** Text of a result as the model receives it: text blocks verbatim, anything else as JSON. */
export function resultText(content: ReadonlyArray<Record<string, unknown>>): string {
  return content.map((block) => (block.type === 'text' ? String(block.text) : JSON.stringify(block))).join('\n');
}

/** Replay the task's scripted native calls round by round. A failing call is a task bug. */
export async function measureNativeCalls(task: Task, urls: Readonly<Record<string, string>>): Promise<NativeMeasure> {
  const calls: NativeMeasure['calls'] = [];
  for (const round of task.native.rounds) {
    for (const call of round) {
      const url = urls[call.server];
      if (!url) throw new Error(`${task.id}: server ${call.server} is not running`);
      const result = await withClient(url, (client) => client.callTool({ name: call.tool, arguments: call.args }));
      const text = resultText(result.content as Array<Record<string, unknown>>);
      if (result.isError) throw new Error(`${task.id}: native call ${call.server}/${call.tool} failed: ${text}`);
      calls.push({
        tool: nativeToolName(call.server, call.tool),
        callBytes: bytesOf(JSON.stringify({ name: nativeToolName(call.server, call.tool), input: call.args })),
        resultBytes: bytesOf(text),
      });
    }
  }
  return {
    turns: task.native.rounds.length + 1,
    callBytes: calls.reduce((n, c) => n + c.callBytes, 0),
    resultBytes: calls.reduce((n, c) => n + c.resultBytes, 0),
    calls,
  };
}
