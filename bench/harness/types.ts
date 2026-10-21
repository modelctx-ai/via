// Shapes of bench/suite.yaml and bench/tasks/<id>.yaml (validated by bench/schema/*.json).

export type Args = Record<string, unknown>;

/** One tool call a native-MCP agent makes. `tool` is the raw MCP name. */
export interface NativeCall {
  server: string;
  tool: string;
  args: Args;
}

/**
 * One canned `tools/call` result served by the replay server. Exactly one of `result`,
 * `resultFile`, `text`, `textFile`, `content` gives the payload (bench/README.md).
 */
export interface CannedCall {
  server: string;
  tool: string;
  /** Subset match against the call's arguments; absent matches any. */
  args?: Args;
  result?: unknown;
  resultFile?: string;
  text?: string;
  textFile?: string;
  content?: Array<Record<string, unknown>>;
  isError?: boolean;
}

/** One command line of a scripted session. The first word is the program (`via`, `mcp2cli` or `mcpc`). */
export interface Step {
  run: string;
  /** Expected exit code; 0 when absent. */
  exit?: number;
}

/**
 * One call pattern of a success criterion (agent evaluation, bench/README.md). `args` is a
 * subset matcher: plain values compare loosely, `$contains`, `$containsAll`, `$regex`, `$oneOf`,
 * `$not` and `$exists` are operators (bench/eval/judge.ts).
 */
export interface Criterion {
  server: string;
  tool: string;
  args?: Args;
  /** `require` only: at most this many matching calls may have been answered. */
  max?: number;
  note?: string;
}

/** How the agent evaluation decides that a run solved the task. */
export interface Success {
  /** Every entry needs a matching call the replay server answered. */
  require: Criterion[];
  /** No attempted call (answered or not) may match any of these. */
  forbid?: Criterion[];
  /** The final answer must mention each entry (case-insensitive); an inner list means any of. */
  answer?: Array<string | string[]>;
}

export interface Task {
  id: string;
  title: string;
  goal: string;
  /** Servers the task touches; a subset of the suite's `mounted`. */
  servers: string[];
  native: { rounds: NativeCall[][] };
  calls: CannedCall[];
  via: Step[];
  mcp2cli?: Step[];
  /** Includes the `mcpc connect` commands: a session must exist before the first call. */
  mcpc?: Step[];
  /** Success criteria for the agent evaluation; the token benchmark does not read them. */
  success?: Success;
}

export interface Suite {
  version: number;
  fixtures: string;
  mounted: string[];
  tasks: string[];
  mcp2cli: { skill: string; version: string };
  mcpc: { skill: string; version: string };
}
