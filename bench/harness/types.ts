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

/** One command line of a scripted session. The first word is the program (`via` or `mcp2cli`). */
export interface Step {
  run: string;
  /** Expected exit code; 0 when absent. */
  exit?: number;
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
}

export interface Suite {
  version: number;
  fixtures: string;
  mounted: string[];
  tasks: string[];
  mcp2cli: { skill: string; version: string };
}
