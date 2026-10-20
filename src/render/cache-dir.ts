import { join } from 'node:path';
import envPaths from 'env-paths';

/** User cache directory for via (`~/.cache/via` on Linux). Cursors and media live below it. */
export function defaultCacheDir(): string {
  return envPaths('via', { suffix: '' }).cache;
}

export function defaultCursorDir(): string {
  return join(defaultCacheDir(), 'cursors');
}

export function defaultMediaDir(): string {
  return join(defaultCacheDir(), 'media');
}
