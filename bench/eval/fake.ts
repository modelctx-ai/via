// The scripted stand-in for a model (`--fake-model`). It plays each task's scripted steps through
// the real loop: the native rounds as parallel tool calls, the `via` / `mcp2cli` / `mcpc` steps as shell
// calls, then a final answer that states the facts the task's `answer` checks look for. It exists
// to prove that servers, tool execution, judging, token accounting, aggregation and the report
// work end to end without an API key. It says nothing about any model: its token counts are
// byte-count estimates, and results from it are labelled as such and never written to
// `bench/results/`.
import type { LoadedSuite } from '../harness/load';
import { nativeToolName } from '../harness/native';
import { BYTES_PER_TOKEN, bytesOf } from '../harness/tokens';
import type { Task } from '../harness/types';
import { SHELL_TOOL } from './prompts';
import type { Block, ChatMessage, ModelFactory, ModelRequest, ModelResponse } from './types';

export const FAKE_MODEL_NAME = 'fake';

const CURSOR = /via more ([0-9a-f]{4,16})\b/;

const estimate = (value: unknown): number => Math.ceil(bytesOf(JSON.stringify(value)) / BYTES_PER_TOKEN);

/** Text of the tool results in the last user message, where a `via more <cursor>` line may be. */
function lastToolOutput(messages: readonly ChatMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last || typeof last.content === 'string') return '';
  return last.content.map((b) => (b.type === 'tool_result' ? String(b.content ?? '') : '')).join('\n');
}

/** A final answer containing what the task's `answer` checks look for. */
function finalAnswer(task: Task): string {
  const facts = (task.success?.answer ?? []).map((want) => (Array.isArray(want) ? want[0]! : want));
  return `Done: ${task.title}.${facts.length > 0 ? ` Key facts: ${facts.join('; ')}.` : ''}`;
}

export function fakeModelFactory(loaded: LoadedSuite): ModelFactory {
  return ({ taskId, condition }) => {
    const task = loaded.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`fake model: unknown task ${taskId}`);
    return {
      name: FAKE_MODEL_NAME,
      async create(request: ModelRequest): Promise<ModelResponse> {
        const turn = request.messages.filter((m) => m.role === 'assistant').length;
        const content: Block[] = [];
        if (condition === 'native') {
          const round = task.native.rounds[turn];
          round?.forEach((call, i) =>
            content.push({ type: 'tool_use', id: `toolu_fake_${turn}_${i}`, name: nativeToolName(call.server, call.tool), input: call.args }),
          );
        } else {
          const step = (condition === 'via' ? task.via : condition === 'mcpc' ? task.mcpc ?? [] : task.mcp2cli ?? [])[turn];
          if (step) {
            const cursor = CURSOR.exec(lastToolOutput(request.messages))?.[1];
            const command = cursor === undefined ? step.run : step.run.replaceAll('{cursor}', cursor);
            content.push({ type: 'tool_use', id: `toolu_fake_${turn}_0`, name: SHELL_TOOL, input: { command } });
          }
        }
        const calling = content.length > 0;
        if (!calling) content.push({ type: 'text', text: finalAnswer(task) });
        return {
          content,
          stopReason: calling ? 'tool_use' : 'end_turn',
          usage: {
            inputTokens: estimate({ system: request.system, tools: request.tools, messages: request.messages }),
            outputTokens: estimate(content),
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        };
      },
    };
  };
}
