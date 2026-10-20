// `via more <cursor>`: continue a truncated result. Needs neither configuration nor catalog.
import { join } from 'node:path';
import { FileCursorStore } from '../../render/cursor-file';
import { renderMore } from '../../render/pipeline';
import type { App } from '../app';
import { usageFailure } from '../failure';

export async function moreCommand(app: App, argv: readonly string[]): Promise<number> {
  if (argv.length !== 1) throw usageFailure('usage: via more <cursor>', 'via -h');
  const out = await renderMore(
    argv[0]!.trim().toLowerCase(),
    { elapsedMs: 0, cursors: new FileCursorStore(join(app.cacheDir, 'cursors'), { now: app.io.now }), now: app.io.now },
    { format: app.options.format, secrets: [] },
  );
  app.out(out.stdout);
  app.err(out.stderr);
  return out.exitCode;
}
