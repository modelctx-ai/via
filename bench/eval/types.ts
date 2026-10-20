// Shapes shared by the agent-evaluation modules (bench/README.md, "agent 评测").
import type { Verdict } from './judge';

export const CONDITIONS = ['native', 'via', 'mcp2cli'] as const;
export type Condition = (typeof CONDITIONS)[number];

/** A tool the model can call (the Messages API `tools` entry). */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** A content block as the API returns it. Blocks are kept opaque so they can be sent back unchanged. */
export type Block = { type: string } & Record<string, unknown>;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | Block[];
}

export interface ModelRequest {
  system: string;
  tools: ToolDef[];
  messages: ChatMessage[];
  maxTokens: number;
}

/** Token usage of one API response, as the API reports it. */
export interface Usage {
  /** Input tokens that were neither read from nor written to the cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ModelResponse {
  content: Block[];
  /** `end_turn`, `tool_use`, `max_tokens`, `refusal` … */
  stopReason: string | null;
  usage: Usage;
}

/** What the loop needs from a model: one turn at a time. */
export interface ModelClient {
  /** Identifier recorded in the results (the model ID, or `fake` for the scripted model). */
  readonly name: string;
  create(request: ModelRequest): Promise<ModelResponse>;
}

/** The run a model is created for; the scripted model needs it to know which script to play. */
export interface ModelContext {
  taskId: string;
  condition: Condition;
}

export type ModelFactory = (context: ModelContext) => ModelClient;

export type RunStatus =
  /** The model stopped calling tools and answered. */
  | 'completed'
  /** The turn limit was reached while the model still wanted tools. */
  | 'max_turns'
  /** The reply was cut off at the output token limit. */
  | 'truncated'
  | 'refused'
  /** The API (or the harness) failed; the run is counted as unsuccessful. */
  | 'error';

/** One tool call of a run, kept in the JSON result for reviewing failures. */
export interface CallRecord {
  turn: number;
  tool: string;
  /** The input object (native) or the command line (CLI conditions). */
  input: unknown;
  isError: boolean;
  /** The tool result as the model saw it, cut to `OUTPUT_PREVIEW` characters. */
  output: string;
}

export const OUTPUT_PREVIEW = 1500;

export interface RunRecord {
  task: string;
  condition: Condition;
  trial: number;
  status: RunStatus;
  /** Message of the failure when `status` is `error`. */
  error?: string;
  success: boolean;
  verdict: Verdict;
  turns: number;
  toolCalls: number;
  /** Calls that exited non-zero, returned `isError` or reached a replay server without a canned result. */
  errorCalls: number;
  /**
   * From the API's `usage`, summed over the turns. `input` is every prompt token, cached or not
   * (uncached + `cacheRead` + `cacheWrite`); `total` is `input + output`.
   */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  wallMs: number;
  finalText: string;
  calls: CallRecord[];
}
