// `via prompt [--out <file>]`: instructions for the agent plus a domain summary. Printed to
// stdout; a file is written only with --out (agent-integration.md).
import { access, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { ExitCode } from '../../render/exit-codes';
import type { App } from '../app';
import { fail } from '../failure';
import { parseLocal } from '../options';
import { renderPrompt } from '../prompt';

export async function promptCommand(app: App, argv: readonly string[]): Promise<number> {
  const { flags, positionals } = parseLocal('prompt', argv, [{ name: 'out', value: true }]);
  if (positionals.length > 0) throw fail(ExitCode.Usage, 'usage: via prompt [--out <file>]', 'via prompt -h');
  const config = await app.config();
  const { entries } = await app.table();
  const { catalog } = await app.loadProviders(entries);
  const text = `${renderPrompt({ catalog, customDomainOrder: Object.keys(config.domains) })}\n`;

  if (typeof flags.out !== 'string') {
    app.out(text);
    return ExitCode.Ok;
  }
  const path = isAbsolute(flags.out) ? flags.out : resolve(app.io.cwd, flags.out);
  // An existing file (AGENTS.md, say) is replaced only on request.
  const exists = await access(path).then(() => true, () => false);
  if (exists && !app.options.yes) {
    throw fail(ExitCode.Denied, `${flags.out} already exists and was not overwritten`, `rerun with --yes to replace it`);
  }
  await writeFile(path, text);
  app.err(`· wrote ${flags.out} · ${Buffer.byteLength(text, 'utf8')} bytes\n`);
  return ExitCode.Ok;
}
