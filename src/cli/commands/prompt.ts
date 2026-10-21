// `via prompt [--skill] [--out <file>] [--check <file>] [--replace]` (guides/agent-integration.md):
// the agent-facing instructions plus the provider list, written as a marked block so the rest of an
// AGENTS.md the user already owns survives every refresh; with `--skill`, as the whole SKILL.md.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { ExitCode } from '../../render/exit-codes';
import { shellArg, shellWord, visibleText } from '../../render/shell';
import type { App } from '../app';
import { fail, usageFailure } from '../failure';
import { parseLocal } from '../options';
import { BlockError, blockStatus, renderPromptBlock, renderSkill, skillStatus, spliceBlock } from '../prompt';

/** First half of the stderr meta line, per splice action (output.md, "元信息行"). */
const META: Record<string, string> = {
  created: 'wrote',
  appended: 'appended to',
  replaced: 'updated the via block in',
  // a whole SKILL.md replaced
  skill: 'updated',
};

/** Write `content`; a missing directory is the person's to create (via does not make skill or config directories). */
async function writeOut(path: string, shown: string, content: string): Promise<void> {
  try {
    await writeFile(path, content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw fail(ExitCode.Usage, `cannot write ${shown}: its directory does not exist`, `mkdir -p ${shellWord(dirname(path))}`);
  }
}

/** The file as it is on disk, or undefined when there is none yet. */
async function readExisting(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

export async function promptCommand(app: App, argv: readonly string[]): Promise<number> {
  const { flags, positionals } = parseLocal('prompt', argv, [
    { name: 'out', value: true },
    { name: 'check', value: true },
    { name: 'replace', value: false },
    { name: 'skill', value: false },
  ]);
  if (positionals.length > 0) {
    throw fail(ExitCode.Usage, 'usage: via prompt [--skill] [--out <file> | --check <file>]', 'via prompt -h', ['to list the prompts of a server: via prompts <provider>']);
  }
  if (typeof flags.out === 'string' && typeof flags.check === 'string') {
    throw usageFailure('via prompt: --out and --check cannot be combined', 'via prompt -h');
  }
  if (flags.replace === true && typeof flags.out !== 'string') {
    throw usageFailure('via prompt: --replace needs --out', 'via prompt -h');
  }
  if (flags.replace === true && flags.skill === true) {
    throw usageFailure('via prompt: --replace has no effect with --skill: a skill file is always written whole', 'via prompt -h');
  }

  const { entries } = await app.table();
  const { catalog } = await app.loadProviders(entries);
  const skill = flags.skill === true;
  const block = skill ? renderSkill({ catalog }) : renderPromptBlock({ catalog });

  if (typeof flags.check !== 'string' && typeof flags.out !== 'string') {
    app.out(`${block}\n`);
    return ExitCode.Ok;
  }

  const given = typeof flags.check === 'string' ? flags.check : (flags.out as string);
  const shown = visibleText(given);
  const file = shellArg(given, { placeholder: 'file', positional: true });
  const path = isAbsolute(given) ? given : resolve(app.io.cwd, given);
  const existing = await readExisting(path);
  if (skill) return skillFile(app, { given: shown, file, path, existing, text: block, check: typeof flags.check === 'string' });

  if (typeof flags.check === 'string') {
    let status: ReturnType<typeof blockStatus>;
    try {
      status = blockStatus(existing, block);
    } catch (error) {
      if (!(error instanceof BlockError)) throw error;
      throw fail(ExitCode.Denied, `${shown}: unusable via block: ${error.message}`, `fix the markers by hand, then rerun via prompt --out ${file}`);
    }
    if (status === 'current') {
      app.err(`· ${shown} is up to date\n`);
      return ExitCode.Ok;
    }
    throw fail(ExitCode.ToolError, status === 'missing' ? `${shown} has no via block` : `${shown} has an out-of-date via block`, `via prompt --out ${file}`);
  }

  // `--replace` is the old whole-file behaviour: the output becomes the entire file.
  const text = flags.replace === true ? `${block}\n` : undefined;
  if (text !== undefined && existing !== undefined && !app.options.yes) {
    throw fail(ExitCode.Denied, `${shown} already exists and was not overwritten`, 'rerun with --yes to replace it', [`without --replace, via prompt keeps your own text and only refreshes the via block`]);
  }
  let content: string;
  let action: string;
  try {
    const spliced = text !== undefined ? { text, action: 'created' as const } : spliceBlock(existing, block);
    content = spliced.text;
    action = spliced.action;
  } catch (error) {
    if (!(error instanceof BlockError)) throw error;
    throw fail(ExitCode.Denied, `${shown}: unusable via block: ${error.message}`, `fix the markers by hand, then rerun via prompt --out ${file}`);
  }
  await writeOut(path, shown, content);
  app.err(`· ${META[action]} ${shown} · ${Buffer.byteLength(content, 'utf8')} bytes\n`);
  return ExitCode.Ok;
}

/**
 * `--skill` with `--out` or `--check`: the file is the whole SKILL.md, so there is no block to find;
 * what matters is whether the file is one via wrote. Only such a file is refreshed without `--yes`.
 */
async function skillFile(app: App, f: { given: string; file: string; path: string; existing: string | undefined; text: string; check: boolean }): Promise<number> {
  const { given: shown, file, path, text } = f;
  const status = skillStatus(f.existing, text);
  const rerun = `via prompt --skill --out ${file}`;
  if (f.check) {
    if (status === 'current') {
      app.err(`· ${shown} is up to date\n`);
      return ExitCode.Ok;
    }
    if (status === 'foreign') throw fail(ExitCode.Denied, `${shown} is not a skill written by via prompt --skill`, `${rerun} --yes to replace it, or use another path`);
    throw fail(ExitCode.ToolError, status === 'missing' ? `${shown} does not exist` : `${shown} is an out-of-date via skill`, rerun);
  }
  if (status === 'foreign' && !app.options.yes) {
    throw fail(ExitCode.Denied, `${shown} already exists and is not a skill written by via prompt --skill; it was not overwritten`, 'rerun with --yes to replace it');
  }
  const content = `${text}\n`;
  await writeOut(path, shown, content);
  app.err(`· ${status === 'missing' ? 'wrote' : META.skill} ${shown} · ${Buffer.byteLength(content, 'utf8')} bytes\n`);
  return ExitCode.Ok;
}
