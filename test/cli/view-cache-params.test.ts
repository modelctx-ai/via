import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProviderCatalog, exampleCommand, type McpTool } from '../../src/catalog';
import { formatCallExample } from '../../src/cli/args/example';
import { ViewCache } from '../../src/cli/view-cache';
import { httpServer } from '../helpers/client';

// The prebuilt catalog keeps the name of a parameter (`_`), its type (`str[]`) and the call example
// (arguments.md, "参数名", "调用示例"; discovery.md, "预构建缓存"): what is read back is what is built.

const IGNORED = { description: 'Ignored.' };
const TOOLS: McpTool[] = [
  { name: 'project_list', inputSchema: { type: 'object', properties: { _: IGNORED, reason: IGNORED } } },
  { name: 'build_run', inputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { todoId: { type: 'string' } }, required: ['todoId'] } }, todoIds: { type: 'array', items: { type: 'string' } }, _: IGNORED }, required: ['items'] } },
];

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('ViewCache, parameter names and types', () => {
  // The example writes JSON, which has no pasteable form on Windows (arguments.md, "调用示例").
  it.skipIf(process.platform === 'win32')('reads back the signature and the example that were built', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'via-view-params-'));
    dirs.push(dir);
    const server = httpServer('http://127.0.0.1:1/board', { name: 'board', provider: 'board' });
    const input = { provider: 'board', tools: TOOLS };
    const listing = { tools: TOOLS, fetchedAt: 1_800_000_000_000 };
    const built = buildProviderCatalog(input);
    const cache = new ViewCache(join(dir, 'catalog'), 'fp-1');
    await cache.write(server, input, listing, built, { examples: true });
    const kept = cache.read(server, input, listing)!.catalog;

    for (const [i, tool] of built.tools.entries()) {
      expect(kept.tools[i]!.params).toEqual(tool.params);
      const line = formatCallExample(tool.def, { provider: tool.provider, ref: tool.ref, rawName: tool.rawName, readOnly: false, destructive: false });
      expect(exampleCommand(kept.tools[i]!)).toBe(line?.slice('example: '.length));
    }
    const byName = Object.fromEntries(kept.tools.map((t) => [t.rawName, t]));
    expect(byName.project_list!.params.map((p) => p.arg)).toEqual(['_', 'reason']);
    expect(exampleCommand(byName.project_list!)).toBeUndefined();
    expect(byName.build_run!.params.map((p) => [p.arg, p.type])).toEqual([['items', 'json'], ['todo-ids', 'str[]'], ['_', undefined]]);
    expect(exampleCommand(byName.build_run!)).toBe(`via board build:run --items '[{"todoId":"text"}]' --todo-ids text`);
  });
});
