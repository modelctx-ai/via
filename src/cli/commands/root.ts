// `via`: status line and providers grouped by domain (discovery.md, "浏览视图").
import { defaultDomainRules, renderRoot, rootEntries } from '../../catalog';
import { ExitCode } from '../../render/exit-codes';
import { userConfigHint } from '../../config/paths';
import type { App } from '../app';

export async function rootCommand(app: App): Promise<number> {
  const config = await app.config();
  const { entries } = await app.table();
  const { catalog, statuses } = await app.loadProviders(entries);
  const text = renderRoot(rootEntries(catalog.providers, statuses), defaultDomainRules(), Object.keys(config.domains));
  app.out(`${text}\n`);
  if (entries.length === 0) {
    app.out(`no MCP servers found: add one to ${userConfigHint(app.io.platform)}, or configure one in an agent framework (see docs/guides/getting-started.md)\n`);
  }
  return ExitCode.Ok;
}
