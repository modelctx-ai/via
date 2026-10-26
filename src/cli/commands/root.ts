// `via`: status line and one row per provider (discovery.md, "浏览视图").
import { renderRoot, rootEntries } from '../../catalog';
import { ExitCode } from '../../render/exit-codes';
import { userConfigHint } from '../../config/paths';
import type { App } from '../app';

export async function rootCommand(app: App): Promise<number> {
  const { entries } = await app.table();
  const { catalog, statuses, details } = await app.loadProviders(entries);
  const text = renderRoot(rootEntries(catalog.providers, statuses, details));
  app.out(`${text}\n`);
  if (entries.length === 0) {
    app.out(`no MCP servers found: add one to ${userConfigHint(app.io.platform)}, or configure one in an agent framework (see docs/guides/getting-started.md)\n`);
  }
  return ExitCode.Ok;
}
