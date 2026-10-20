// `via sync [provider]`: refresh the tool list cache from the servers.
import { ExitCode } from '../../render/exit-codes';
import { alignRows } from '../../render/width';
import type { App } from '../app';
import { toErrorInfo } from '../app';
import { statusOf } from '../directory';
import { usageFailure } from '../failure';
import { resolveEntry } from '../target';

export async function syncCommand(app: App, argv: readonly string[]): Promise<number> {
  if (argv.length > 1) throw usageFailure('usage: via sync [<provider>]', 'via sync -h');
  const { entries } = await app.table();
  const chosen = argv[0] === undefined ? entries : [await resolveEntry(app, argv[0])];
  const results = await Promise.all(
    chosen.map(async (entry) => {
      try {
        const { tools } = await app.listing(entry, { refresh: true, many: true });
        return { entry, row: [entry.name, `${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`], code: ExitCode.Ok as number };
      } catch (error) {
        const info = await toErrorInfo(error);
        const label = { 'needs-auth': 'needs auth', error: 'failed', untrusted: 'untrusted' }[statusOf(error)];
        return { entry, row: [entry.name, `${label}: ${app.redact.scan(info.message)}`], code: info.code as number };
      }
    }),
  );
  app.out(`${alignRows(results.map((r) => r.row)).join('\n')}\n`);
  const code = results.reduce((max, r) => Math.max(max, r.code), 0);
  if (code !== 0) app.err('next: via doctor\n');
  return code;
}
