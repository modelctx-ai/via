// Loading and validating the suite: JSON Schema for the shape, then the cross-file rules the
// schema cannot express (servers mounted, tools exist, native arguments fit the tool's schema,
// referenced files exist, commands start with the right program).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { parse as parseYaml } from 'yaml';
import { readTools, type ReplayTool } from '../replay-server.mjs';
import { splitCommand } from './shell';
import type { Suite, Task } from './types';

export interface LoadedSuite {
  /** Repository root every suite path is relative to. */
  root: string;
  /** `<root>/bench`: where `resultFile` / `textFile` paths resolve. */
  benchDir: string;
  suite: Suite;
  tasks: Task[];
  /** `tools/list` fixture per mounted server. */
  tools: Map<string, ReplayTool[]>;
}

const readYaml = (path: string): unknown => parseYaml(readFileSync(path, 'utf8'));
const readJson = (path: string): object => JSON.parse(readFileSync(path, 'utf8')) as object;

function schemaProblems(ajv: Ajv, schema: object, value: unknown, label: string): string[] {
  const validate = ajv.compile(schema);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => `${label}${e.instancePath || '/'}: ${e.message ?? 'invalid'}`);
}

/** Load `bench/suite.yaml` and its tasks. Throws one error listing every problem found. */
export function loadSuite(root: string, only?: readonly string[]): LoadedSuite {
  // Entries of `only` select the tasks whose id contains them ("bugs" picks "x-triage-bugs").
  const benchDir = join(root, 'bench');
  const ajv = new Ajv({ allErrors: true, strict: true });
  const problems: string[] = [];

  const suiteValue = readYaml(join(benchDir, 'suite.yaml'));
  problems.push(...schemaProblems(ajv, readJson(join(benchDir, 'schema/suite.schema.json')), suiteValue, 'suite.yaml'));
  if (problems.length > 0) throw new Error(problems.join('\n'));
  const suite = suiteValue as Suite;

  const taskSchema = readJson(join(benchDir, 'schema/task.schema.json'));
  const tasks: Task[] = [];
  for (const id of suite.tasks) {
    if (only && only.length > 0 && !only.some((pattern) => id.includes(pattern))) continue;
    const file = join(benchDir, 'tasks', `${id}.yaml`);
    if (!existsSync(file)) {
      problems.push(`tasks/${id}.yaml: file not found`);
      continue;
    }
    const value = readYaml(file);
    const found = schemaProblems(ajv, taskSchema, value, `tasks/${id}.yaml`);
    problems.push(...found);
    if (found.length === 0) tasks.push(value as Task);
  }
  if (only) for (const pattern of only) if (!suite.tasks.some((id) => id.includes(pattern))) problems.push(`no task matches: ${pattern}`);

  const tools = new Map<string, ReplayTool[]>();
  for (const server of suite.mounted) {
    const file = join(root, suite.fixtures, `${server}.json`);
    if (existsSync(file)) tools.set(server, readTools(file));
    else problems.push(`suite.yaml: no tools/list fixture for mounted server ${server} (${file})`);
  }

  const loaded: LoadedSuite = { root, benchDir, suite, tasks, tools };
  for (const task of tasks) problems.push(...checkTask(loaded, task));
  if (!existsSync(join(root, suite.mcp2cli.skill))) problems.push(`suite.yaml: mcp2cli.skill not found: ${suite.mcp2cli.skill}`);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return loaded;
}

/** Cross-file rules for one task; returns the problems found. */
export function checkTask(loaded: LoadedSuite, task: Task): string[] {
  const out: string[] = [];
  const at = (where: string, message: string): void => void out.push(`tasks/${task.id}.yaml ${where}: ${message}`);
  const toolsOf = (server: string): ReplayTool[] | undefined => loaded.tools.get(server);

  for (const server of task.servers) if (!loaded.suite.mounted.includes(server)) at('servers', `${server} is not mounted in suite.yaml`);

  const checkTool = (where: string, server: string, tool: string): ReplayTool | undefined => {
    if (!task.servers.includes(server)) at(where, `server ${server} is not listed in servers`);
    const found = toolsOf(server)?.find((t) => t.name === tool);
    if (!found) at(where, `${server} has no tool ${tool}`);
    return found;
  };

  const argAjv = new Ajv({ strict: false, allErrors: true });
  task.native.rounds.forEach((round, r) =>
    round.forEach((call, c) => {
      const where = `native.rounds[${r}][${c}]`;
      const tool = checkTool(where, call.server, call.tool);
      if (!tool) return;
      const validate = argAjv.compile(tool.inputSchema);
      if (!validate(call.args)) for (const e of validate.errors ?? []) at(where, `${call.tool} arguments${e.instancePath}: ${e.message ?? 'invalid'}`);
    }),
  );

  task.calls.forEach((call, i) => {
    const where = `calls[${i}]`;
    checkTool(where, call.server, call.tool);
    for (const key of ['resultFile', 'textFile'] as const) {
      const path = call[key];
      if (path !== undefined && !existsSync(join(loaded.benchDir, path))) at(where, `${key} not found: bench/${path}`);
    }
  });

  // Every native call needs a canned result that would answer it.
  for (const call of task.native.rounds.flat()) {
    if (!task.calls.some((c) => c.server === call.server && c.tool === call.tool)) at('native', `${call.server}/${call.tool} has no entry in calls`);
  }

  const checkSteps = (key: 'via' | 'mcp2cli', program: string): void => {
    (task[key] ?? []).forEach((step, i) => {
      const where = `${key}[${i}]`;
      try {
        const words = splitCommand(step.run);
        if (words[0] !== program) at(where, `a ${key} step must start with \`${program}\`: ${step.run}`);
      } catch (error) {
        at(where, (error as Error).message);
      }
    });
  };
  checkSteps('via', 'via');
  checkSteps('mcp2cli', 'mcp2cli');
  return out;
}
