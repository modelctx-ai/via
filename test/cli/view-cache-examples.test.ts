import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProviderCatalog, exampleCommand, type CatalogTool, type McpTool, type ProviderInput } from '../../src/catalog';
import { formatCallExample } from '../../src/cli/args/example';
import { cacheKey } from '../../src/cli/catalog-cache';
import { stringHash } from '../../src/hash';
import { ViewCache } from '../../src/cli/view-cache';
import { httpServer } from '../helpers/client';
import { fixtureNames, loadTools } from '../helpers/fixtures';

// The call example under each `via find` result is the line `-h` writes (arguments.md, "调用示例"),
// made once from the schemas and kept in the prebuilt catalog (view-cache.ts), so that listing
// results never read the schemas.

const FETCHED_AT = 1_800_000_000_000;
const PROVIDERS = fixtureNames('tools');

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'via-view-ex-'));
  dirs.push(dir);
  return join(dir, 'catalog');
}

const listing = (tools: McpTool[]) => ({ tools, fetchedAt: FETCHED_AT });
const input = (provider: string, tools: McpTool[]): ProviderInput => ({ provider, tools });
const helpLine = (tool: CatalogTool): string | undefined =>
  formatCallExample(tool.def, { provider: tool.provider, ref: tool.ref, rawName: tool.rawName, readOnly: tool.readOnly, destructive: tool.destructive });

describe('ViewCache and call examples', () => {
  it.each(PROVIDERS)('%s: the kept example is the -h example of every tool, whether written with the build or added to a build made without', async (name) => {
    const tools = loadTools('tools', name);
    const server = httpServer(`http://127.0.0.1:1/${name}`, { name, provider: name });
    const inp = input(name, tools);
    const cache = new ViewCache(scratch(), 'fp-1');

    // Written with the build: the tools of the catalog being written carry the examples too.
    const built = buildProviderCatalog(inp);
    await cache.write(server, inp, listing(tools), built, { examples: true });
    const kept = cache.read(server, inp, listing(tools))!;
    expect(kept.examples).toBe(true);

    // A build made by a browse has none; writing the restored catalog again with them adds them.
    await cache.write(server, inp, listing(tools), buildProviderCatalog(inp));
    const without = cache.read(server, inp, listing(tools))!;
    expect(without.examples).toBe(false);
    expect(without.catalog.tools.every((t) => t.exampleArgs === undefined)).toBe(true);
    await cache.write(server, inp, listing(tools), without.catalog, { examples: true });
    const added = cache.read(server, inp, listing(tools))!;
    expect(added.examples).toBe(true);

    let withExample = 0;
    for (const [i, tool] of added.catalog.tools.entries()) {
      const line = helpLine(tool);
      expect(exampleCommand(tool), `${name}/${tool.rawName}`).toBe(line?.slice('example: '.length));
      expect(exampleCommand(kept.catalog.tools[i]!)).toBe(exampleCommand(tool));
      expect(exampleCommand(built.tools[i]!)).toBe(exampleCommand(tool));
      if (line) withExample += 1;
    }
    expect(withExample).toBeGreaterThan(0);
  });

  it('does not use a file whose examples were quoted for the other kind of shell', async () => {
    const tools = loadTools('tools', 'github');
    const server = httpServer('http://127.0.0.1:1/gh', { name: 'gh', provider: 'gh' });
    const inp = input('gh', tools);
    const dir = scratch();
    await new ViewCache(dir, 'fp-1').write(server, inp, listing(tools), buildProviderCatalog(inp), { examples: true });
    const file = join(dir, `${cacheKey(server)}.${stringHash('gh').slice(0, 8)}.view.json`);
    const data = JSON.parse(readFileSync(file, 'utf8')) as { plat: string };
    expect(data.plat).toBe(process.platform === 'win32' ? 'win' : 'posix');
    writeFileSync(file, JSON.stringify({ ...data, plat: data.plat === 'win' ? 'posix' : 'win' }));
    expect(new ViewCache(dir, 'fp-1').read(server, inp, listing(tools))).toBeUndefined();
  });
});
