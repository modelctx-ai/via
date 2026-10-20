import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAnthropicClient } from '../../bench/eval/anthropic';
import { runEval } from '../../bench/eval/run';
import { loadSuite } from '../../bench/harness/load';
import { makeRunners } from '../../bench/harness/runners';

// The live model client against a local stand-in for the Messages API: proves the request shape,
// the usage accounting (cache tokens included) and the tool loop without a key or network.

const root = fileURLToPath(new URL('../..', import.meta.url));

describe('the live client', () => {
  it('sends tools, system and history, reads usage including cache tokens, and drives a whole task', { timeout: 60_000 }, async () => {
    const bodies: Array<{ messages: unknown[] } & Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: unknown[] } & Record<string, unknown>;
        bodies.push(body);
        const first = body.messages.length === 1;
        const message = {
          id: `msg_${bodies.length}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: first ? [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__cloudflare__whoami', input: {} }] : [{ type: 'text', text: 'checked' }],
          stop_reason: first ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
        };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const { port } = server.address() as { port: number };
      const client = await createAnthropicClient({ model: 'test-model', apiKey: 'test-key', baseURL: `http://127.0.0.1:${port}`, effort: 'low', cache: true, maxRetries: 0 });
      const loaded = loadSuite(root, ['dns-records']);
      const [record] = await runEval({ loaded, conditions: ['native'], trials: 1, maxTurns: 5, maxTokens: 512, concurrency: 1, runners: makeRunners({ viaBin: 'unused' }), model: () => client });
      expect(record!.status).toBe('completed');
      expect(record!.turns).toBe(2);
      expect(record!.toolCalls).toBe(1);
      expect(record!.tokens).toEqual({ input: 28, output: 6, cacheRead: 10, cacheWrite: 4, total: 34 });

      const first = bodies[0]!;
      expect(first).toMatchObject({ model: 'test-model', max_tokens: 512, cache_control: { type: 'ephemeral' }, output_config: { effort: 'low' } });
      expect((first.tools as Array<{ name: string }>).map((t) => t.name)).toContain('mcp__github__list_issues');
      expect(String(first.system)).toContain('autonomous agent');
      const second = bodies[1]!.messages as Array<{ role: string; content: unknown }>;
      expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(JSON.stringify(second[2]!.content)).toContain('tool_result');
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
