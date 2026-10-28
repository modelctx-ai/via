// `via`: status line and one row per provider (discovery.md, "浏览视图").
import { renderRoot, rootEntries, rootJson, ROOT_HINT } from '../../catalog';
import { ExitCode } from '../../render/exit-codes';
import { pathContext, userConfigHint } from '../../config/paths';
import type { App } from '../app';
import { rejectRaw, writeJson } from '../listing-output';

export async function rootCommand(app: App): Promise<number> {
  rejectRaw(app, []);
  const { entries } = await app.table();
  const { catalog, statuses, details } = await app.loadProviders(entries);
  const providers = rootEntries(catalog.providers, statuses, details);
  const none = `no MCP servers found: add one to ${userConfigHint(pathContext({ home: app.io.home, env: app.io.env, platform: app.io.platform }))}, or configure one in an agent framework (see docs/guides/getting-started.md)\n`;
  if (app.options.format === 'json') {
    // stdout is the data; the hint and the note about an empty configuration stay on stderr.
    await writeJson(app, rootJson(providers));
    app.err(`${ROOT_HINT}\n`);
    if (entries.length === 0) app.err(none);
    return ExitCode.Ok;
  }
  app.out(`${renderRoot(providers)}\n`);
  if (entries.length === 0) app.out(none);
  return ExitCode.Ok;
}
