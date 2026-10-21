// `via prompt [--out <file>] [--check <file>] [--replace]` (guides/agent-integration.md): the
// agent-facing instructions plus the provider list, written as a marked block so the rest of an
// AGENTS.md the user already owns survives every refresh.
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { ExitCode } from '../../render/exit-codes';
import type { App } from '../app';
import { fail, usageFailure } from '../failure';
import { parseLocal } from '../options';
import { BlockError, blockStatus, renderPromptBlock, spliceBlock } from '../prompt';

/** First half of the stderr meta line, per splice action (output.md, "元信息行"). */
const META: Record<string, string> = {
  created: 'wrote',
  appended: 'appended to',
  replaced: 'updated the via block in',
};

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
  ]);
  if (positionals.length > 0) {
    throw fail(ExitCode.Usage, 'usage: via prompt [--out <file> | --check <file>]', 'via prompt -h', ['to list the prompts of a server: via prompts <provider>']);
  }
  if (typeof flags.out === 'string' && typeof flags.check === 'string') {
    throw usageFailure('via prompt: --out and --check cannot be combined', 'via prompt -h');
  }
  if (flags.replace === true && typeof flags.out !== 'string') {
    throw usageFailure('via prompt: --replace needs --out', 'via prompt -h');
  }

  const { entries } = await app.table();
  const { catalog } = await app.loadProviders(entries);
  const block = renderPromptBlock({ catalog });

  if (typeof flags.check !== 'string' && typeof flags.out !== 'string') {
    app.out(`${block}\n`);
    return ExitCode.Ok;
  }

  const given = typeof flags.check === 'string' ? flags.check : (flags.out as string);
  const path = isAbsolute(given) ? given : resolve(app.io.cwd, given);
  const existing = await readExisting(path);

  if (typeof flags.check === 'string') {
    let status: ReturnType<typeof blockStatus>;
    try {
      status = blockStatus(existing, block);
    } catch (error) {
      if (!(error instanceof BlockError)) throw error;
      throw fail(ExitCode.Denied, `${given}: unusable via block: ${error.message}`, `fix the markers by hand, then rerun via prompt --out ${given}`);
    }
    if (status === 'current') {
      app.err(`· ${given} is up to date\n`);
      return ExitCode.Ok;
    }
    throw fail(ExitCode.ToolError, status === 'missing' ? `${given} has no via block` : `${given} has an out-of-date via block`, `via prompt --out ${given}`);
  }

  // `--replace` is the old whole-file behaviour: the output becomes the entire file.
  const text = flags.replace === true ? `${block}\n` : undefined;
  if (text !== undefined && existing !== undefined && !app.options.yes) {
    throw fail(ExitCode.Denied, `${given} already exists and was not overwritten`, 'rerun with --yes to replace it', [`without --replace, via prompt keeps your own text and only refreshes the via block`]);
  }
  let content: string;
  let action: string;
  try {
    const spliced = text !== undefined ? { text, action: 'created' as const } : spliceBlock(existing, block);
    content = spliced.text;
    action = spliced.action;
  } catch (error) {
    if (!(error instanceof BlockError)) throw error;
    throw fail(ExitCode.Denied, `${given}: unusable via block: ${error.message}`, `fix the markers by hand, then rerun via prompt --out ${given}`);
  }
  await writeFile(path, content);
  app.err(`· ${META[action]} ${given} · ${Buffer.byteLength(content, 'utf8')} bytes\n`);
  return ExitCode.Ok;
}
