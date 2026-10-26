// Whether via's own config files could say anything about `commands` or `sandbox`, decided before
// a command is dispatched (ADR 0027, ADR 0028). Every command, `-h` included, asks this, so it only
// reads the two files and looks for the words: the YAML library is loaded only when one is there.
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { decodeText } from '../platform/text';
import { pathIdentity, userConfigPath, type PathContext } from './paths';

/** The project config file name; the first one found walking up from the working directory is used. */
export const PROJECT_CONFIG_NAME = '.via.yaml';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Nearest ancestor (starting at `from`) that contains `relative` as a file. */
export function findUp(relative: string, from: string, ceiling: string | undefined, platform: NodeJS.Platform): string | undefined {
  let dir = resolve(from);
  const stop = ceiling === undefined ? undefined : pathIdentity(ceiling, platform);
  for (;;) {
    const candidate = join(dir, relative);
    if (isFile(candidate)) return candidate;
    const parent = dirname(dir);
    // Case-insensitive on Windows: `c:\repo` and `C:\Repo` are the same ceiling.
    if (parent === dir || pathIdentity(dir, platform) === stop) return undefined;
    dir = parent;
  }
}

/**
 * Either key anywhere in the text. Deliberately loose: a false match only costs a parse, while a
 * missed one would run a command that `commands.deny` refuses (`"commands":`, flow mappings).
 */
const MENTION = /\b(?:commands|sandbox)\b/;

/** The user and project config files that mention `commands` or `sandbox`; empty when neither does. */
export function policyFiles(ctx: PathContext, cwd: string, ceiling?: string): string[] {
  const files: string[] = [];
  for (const path of [userConfigPath(ctx), findUp(PROJECT_CONFIG_NAME, cwd, ceiling, ctx.platform)]) {
    if (path === undefined) continue;
    let text: string;
    try {
      text = decodeText(readFileSync(path));
    } catch {
      continue;
    }
    if (MENTION.test(text)) files.push(path);
  }
  return files;
}
