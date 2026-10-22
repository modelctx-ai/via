// Post-build step for tsup: put a `package.json` next to the chunks.
//
// To know whether a `.js` file is an ES module, Node looks for the nearest `package.json`, starting
// in the file's own directory. `dist/` had none, so each of the ~40 chunks a browse command loads
// first failed to open `dist/package.json` (and the lookups that go with it) before finding the
// package's own one a level up: about 200 failed `openat` calls per run, 2 to 3 ms (strace on
// `via find`). With this file the nearest one is right there and Node caches it.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DIST_MANIFEST = '{"type":"module"}\n';

export function writeDistManifest(dir: string): void {
  writeFileSync(join(dir, 'package.json'), DIST_MANIFEST);
}
