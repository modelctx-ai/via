// The agent loop: one model, one set of tools, one task. The model answers, asks for tools, gets
// the results back, and so on until it stops asking, the turn limit is reached or something
// fails. All tool results of a turn go back in a single user message, as the Messages API
// expects for parallel tool use. Assistant content is appended unchanged (thinking blocks and
// all), so the history stays valid however the model is configured.
import type { Task } from '../harness/types';
import { judge, successOf, type LoggedCall } from './judge';
import { userMessage } from './prompts';
import type { AgentTools } from './tools';
import { OUTPUT_PREVIEW, type Block, type CallRecord, type ChatMessage, type Condition, type ModelClient, type RunRecord, type RunStatus, type Usage } from './types';

export interface LoopOptions {
  task: Task;
  condition: Condition;
  trial: number;
  model: ModelClient;
  system: string;
  tools: AgentTools;
  maxTurns: number;
  maxTokens: number;
  /** Everything the replay servers received, read after the loop to judge the run. */
  calls(): LoggedCall[];
}

const textOf = (blocks: readonly Block[]): string =>
  blocks
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('\n')
    .trim();

const preview = (text: string): string => (text.length > OUTPUT_PREVIEW ? `${text.slice(0, OUTPUT_PREVIEW)}… [${text.length - OUTPUT_PREVIEW} more characters]` : text);

export async function runAgent(options: LoopOptions): Promise<RunRecord> {
  const { task, condition, model, tools } = options;
  const started = Date.now();
  const messages: ChatMessage[] = [{ role: 'user', content: userMessage(task) }];
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const calls: CallRecord[] = [];
  let turns = 0;
  let status: RunStatus = 'max_turns';
  let error: string | undefined;
  let finalText = '';

  try {
    while (turns < options.maxTurns) {
      turns += 1;
      const response = await model.create({ system: options.system, tools: tools.defs, messages, maxTokens: options.maxTokens });
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      usage.cacheReadTokens += response.usage.cacheReadTokens;
      usage.cacheWriteTokens += response.usage.cacheWriteTokens;
      messages.push({ role: 'assistant', content: response.content });

      if (response.stopReason === 'refusal') {
        status = 'refused';
        break;
      }
      const uses = response.content.filter((b) => b.type === 'tool_use');
      if (response.stopReason === 'max_tokens') {
        // A cut-off reply may hold a half-written tool call; it cannot be executed.
        status = 'truncated';
        finalText = textOf(response.content);
        break;
      }
      if (uses.length === 0) {
        status = 'completed';
        finalText = textOf(response.content);
        break;
      }

      const results: Block[] = [];
      for (const use of uses) {
        const result = await tools.call(String(use.name), use.input);
        calls.push({ turn: turns, tool: String(use.name), input: result.recorded, isError: result.isError, output: preview(result.text) });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: result.text, ...(result.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
  } catch (caught) {
    status = 'error';
    error = caught instanceof Error ? caught.message : String(caught);
  }

  // A run that did not finish (turn limit, cut-off reply, refusal, failure) is still judged, so
  // its checks show how far it got, but it never counts as a success.
  const verdict = judge(successOf(task), options.calls(), finalText);
  const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return {
    task: task.id,
    condition,
    trial: options.trial,
    status,
    ...(error !== undefined ? { error } : {}),
    success: status === 'completed' && verdict.success,
    verdict,
    turns,
    toolCalls: calls.length,
    errorCalls: calls.filter((c) => c.isError).length,
    tokens: { input, output: usage.outputTokens, cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens, total: input + usage.outputTokens },
    wallMs: Date.now() - started,
    finalText,
    calls,
  };
}
