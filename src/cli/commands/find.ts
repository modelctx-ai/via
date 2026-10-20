// `via find <query> [--domain <domain>] [-n <count>]`
import { normalizeInput, renderFind, SearchIndex } from '../../catalog';
import { ExitCode } from '../../render/exit-codes';
import type { App } from '../app';
import { usageFailure } from '../failure';
import { parseLocal } from '../options';

export async function findCommand(app: App, argv: readonly string[]): Promise<number> {
  const { flags, positionals } = parseLocal('find', argv, [
    { name: 'domain', value: true },
    { name: 'limit', value: true, short: 'n' },
  ]);
  let limit = 10;
  if (flags.limit !== undefined) {
    limit = Number(flags.limit);
    if (!Number.isInteger(limit) || limit < 1) throw usageFailure(`-n must be a positive integer (got ${JSON.stringify(String(flags.limit).slice(0, 40))})`, 'via find -h');
  }
  const query = positionals.join(' ');
  const { entries } = await app.table();
  const { catalog, terms, failures } = await app.loadProviders(entries);
  const hits = new SearchIndex(catalog, undefined, terms).search(query, {
    limit,
    ...(typeof flags.domain === 'string' ? { domain: normalizeInput(flags.domain) } : {}),
  });
  app.out(`${renderFind(hits, query)}\n`);
  if (failures.length > 0) {
    const names = failures.map((f) => f.entry.name).sort().join(', ');
    app.err(`warning: ${failures.length} provider${failures.length === 1 ? '' : 's'} could not be searched: ${names} (see via, via doctor)\n`);
  }
  return ExitCode.Ok;
}
