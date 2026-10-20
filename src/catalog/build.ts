import { buildProviderCatalog, defaultCatalogRules, type CatalogRules, type ProviderInput } from './provider';
import type { Catalog, CatalogWarning, ProviderCatalog } from './types';

/**
 * Built-in subcommand names (cli.md), plus `help`, the command the argument parser adds on its own.
 * A provider alias equal to one of these must be renamed in config; such providers are left out
 * of the catalog with a warning.
 */
export const RESERVED_COMMANDS: readonly string[] = [
  'find',
  'call',
  'more',
  'batch',
  'servers',
  'auth',
  'trust',
  'sync',
  'doctor',
  'prompt',
  'daemon',
  'resources',
  'read',
  'prompts',
  'help',
];

/** Provider names are lower-case kebab-case (glossary). */
export function normalizeProviderName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build the catalog from already-fetched `tools/list` results (discovery.md, steps 2-6).
 * Fetching and disk caching are the caller's job; splitting, domain inference and indexing are
 * recomputed here so rule upgrades never need a cache flush.
 */
export function buildCatalog(
  inputs: readonly ProviderInput[],
  rules: CatalogRules = defaultCatalogRules(),
): Catalog {
  const providers: ProviderCatalog[] = [];
  const warnings: CatalogWarning[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const provider = normalizeProviderName(input.provider);
    if (RESERVED_COMMANDS.includes(provider)) {
      warnings.push({
        provider,
        code: 'reserved-name',
        message: `provider name "${provider}" collides with a built-in subcommand; set "alias" in the server config`,
      });
      continue;
    }
    if (seen.has(provider)) {
      warnings.push({
        provider,
        code: 'duplicate-provider',
        message: `provider "${provider}" is defined more than once; the first definition is used`,
      });
      continue;
    }
    seen.add(provider);
    providers.push(buildProviderCatalog({ ...input, provider }, rules));
  }
  providers.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));
  return { providers, warnings };
}
