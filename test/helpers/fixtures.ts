import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog, buildProviderCatalog, type McpTool, type ProviderInput } from '../../src/catalog';

export const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

export function loadTools(dir: string, name: string): McpTool[] {
  return (JSON.parse(readFileSync(join(FIXTURES, dir, `${name}.json`), 'utf8')) as { tools: McpTool[] }).tools;
}

export function fixtureNames(dir: string): string[] {
  return readdirSync(join(FIXTURES, dir))
    .filter((f) => f.endsWith('.json'))
    .map((f) => basename(f, '.json'))
    .sort();
}

export function providerFixture(dir: string, name: string, extra: Partial<ProviderInput> = {}) {
  return buildProviderCatalog({ provider: name, tools: loadTools(dir, name), ...extra });
}

export function catalogFixture(dir: string, names = fixtureNames(dir)) {
  return buildCatalog(names.map((name) => ({ provider: name, tools: loadTools(dir, name) })));
}
