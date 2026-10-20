// The live model: the Anthropic Messages API through the official SDK. The SDK is a devDependency
// (via itself has no runtime dependency on it) and is imported only when a live evaluation runs.
import type Anthropic from '@anthropic-ai/sdk';
import type { Block, ModelClient, ModelRequest, ModelResponse } from './types';

/** Default model of the evaluation; override with `--model`. */
export const DEFAULT_MODEL = 'claude-opus-5-5';

export interface AnthropicOptions {
  model: string;
  /** Output effort (`low` … `max`). Omitted: the API default of the model. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Automatic prompt caching of the growing conversation prefix. */
  cache?: boolean;
  /** Defaults to `ANTHROPIC_API_KEY`. */
  apiKey?: string;
  /** Defaults to `ANTHROPIC_BASE_URL`, then the public API. */
  baseURL?: string;
  maxRetries?: number;
}

export async function createAnthropicClient(options: AnthropicOptions): Promise<ModelClient> {
  const { default: SDK } = await import('@anthropic-ai/sdk');
  const client = new SDK({
    apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY,
    baseURL: options.baseURL ?? process.env.ANTHROPIC_BASE_URL ?? undefined,
    // The SDK retries 408/409/429/5xx and connection errors with backoff.
    maxRetries: options.maxRetries ?? 5,
  });
  return {
    name: options.model,
    async create(request: ModelRequest): Promise<ModelResponse> {
      const response = await client.messages.create({
        model: options.model,
        max_tokens: request.maxTokens,
        system: request.system,
        tools: request.tools as Anthropic.Tool[],
        messages: request.messages as unknown as Anthropic.MessageParam[],
        ...(options.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
        ...(options.effort ? { output_config: { effort: options.effort } } : {}),
      });
      return {
        content: response.content as unknown as Block[],
        stopReason: response.stop_reason,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}
