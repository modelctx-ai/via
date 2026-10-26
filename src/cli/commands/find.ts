// `via find <query> [-n <count>]`
import { renderFind, SearchIndex } from '../../catalog';
import { ExitCode } from '../../render/exit-codes';
import type { App } from '../app';
import { usageFailure } from '../failure';
import { parseLocal } from '../options';

export async function findCommand(app: App, argv: readonly string[]): Promise<number> {
  const { flags, positionals } = parseLocal('find', argv, [{ name: 'limit', value: true, short: 'n' }]);
  let limit = 10;
  if (flags.limit !== undefined) {
    limit = Number(flags.limit);
    if (!Number.isInteger(limit) || limit < 1) throw usageFailure(`-n must be a positive integer (got ${JSON.stringify(String(flags.limit).slice(0, 40))})`, 'via find -h');
  }
  const query = positionals.join(' ');
  const { entries } = await app.table();
  const { catalog, terms, statuses, failures, background } = await app.loadProviders(entries);

  // Optional embedding retrieval (ADR 0011): off unless the user config enables it, and then loaded
  // on demand. Any failure leaves the lexical ranking and a meta line.
  const semanticConfig = (await app.config()).search?.semantic;
  const semantic = semanticConfig && query.trim() !== '' ? await (await import('../semantic')).semanticFind(app, semanticConfig, catalog, query) : undefined;

  const hits = new SearchIndex(catalog, undefined, { precomputed: terms }).search(query, {
    limit,
    ...(semantic?.scores ? { semantic: semantic.scores } : {}),
  });
  app.out(`${renderFind(hits, query)}\n`);
  // Providers that are still starting are told apart from the ones that could not be searched: the first
  // are worth asking again in a moment, the second need a look (discovery.md, "浏览视图").
  const starting = failures.filter((f) => statuses[f.entry.name] === 'starting').map((f) => f.entry.name).sort();
  const failed = failures.filter((f) => statuses[f.entry.name] !== 'starting').map((f) => f.entry.name).sort();
  const count = (names: readonly string[]): string => `${names.length} provider${names.length === 1 ? '' : 's'}`;
  if (starting.length > 0) {
    const hint = background ? 'retry in a moment' : `no daemon keeps connecting: via sync ${starting.join(' ')}`;
    app.err(`warning: ${count(starting)} still starting: ${starting.join(', ')} (${hint})\n`);
  }
  if (failed.length > 0) app.err(`warning: ${count(failed)} could not be searched: ${failed.join(', ')} (see via, via doctor)\n`);
  if (semantic?.note) app.err(await app.redactText(`· semantic unavailable: ${semantic.note} · lexical results\n`));
  else if (semantic && semantic.embedded > 0) app.err(`· semantic · embedded ${semantic.embedded} tool${semantic.embedded === 1 ? '' : 's'} (cached)\n`);
  return ExitCode.Ok;
}
