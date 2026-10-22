// `via skills <provider> [<name> [<file>]]` (cli.md, "skills"; ADR 0020): the skills a server publishes through the
// `io.modelcontextprotocol/skills` extension, and their files. A file is printed only after the client checked its size
// and sha256 against the skill's manifest; one that does not match is refused (the check is in the session, before the
// daemon redacts anything). Like `via resources`, it is read-only and shares the provider resolution and the pipeline.
import { didYouMean, normalizeInput } from '../../catalog';
import { ClientError } from '../../client/errors';
import { skillRoot } from '../../client/skills';
import { notFoundError } from '../../render/errors';
import { ExitCode } from '../../render/exit-codes';
import { shellArg, shellWords, visibleText } from '../../render/shell';
import type { App } from '../app';
import { CliFailure, usageFailure } from '../failure';
import { filesHint, findSkill, skillFileResult, skillListing } from '../skills';
import { noOptions, open, print, safe } from './mcp-data';

const USAGE = 'usage: via skills <provider> [<name> [<file>]]';

export async function skillsCommand(app: App, argv: readonly string[]): Promise<number> {
  noOptions('skills', argv);
  const [typed, name, file, ...extra] = argv;
  if (typed === undefined || extra.length > 0 || (name === undefined && file !== undefined)) throw usageFailure(USAGE, 'via skills -h');
  const { entry, timeoutMs } = await open(app, 'skills', typed);
  const backend = await app.backend();
  const started = app.io.now();
  const onWarning = (message: string): void => app.err(`warning: ${app.redact.scan(message)}\n`);
  const skills = await backend.listSkills(entry.server.name, { timeoutMs, onWarning });
  const ref = `skills ${entry.name}`;
  if (name === undefined) return print(app, entry, ref, started, skillListing(safe(app, skills), entry.name, app.options.format));

  const found = findSkill(skills, name);
  if (found.kind === 'ambiguous') {
    throw new CliFailure({
      code: ExitCode.NotFound,
      message: `ambiguous skill: ${visibleText(name)}`,
      lines: [`candidates: ${found.paths.map((p) => shellArg(p, { placeholder: 'name' })).join(' · ')}`],
      next: `via skills ${shellWords(entry.name)} ${shellArg(found.paths[0]!, { placeholder: 'name', positional: true })}`,
    });
  }
  // A listing may be partial: a skill it does not mention can still be served, under the conventional URI.
  const uri = found.kind === 'found' ? found.uri : `skill://${name.replace(/^\/+|\/+$/g, '')}/SKILL.md`;
  let read;
  try {
    read = await backend.readSkill(entry.server.name, uri, file, { timeoutMs, onWarning });
  } catch (error) {
    if (found.kind === 'none' && error instanceof ClientError && error.exitCode === ExitCode.NotFound && error.message.startsWith('no such skill')) {
      const wanted = normalizeInput(name);
      const suggestions = didYouMean(wanted, found.names.map((n) => normalizeInput(n)))
        .map((n) => found.names.find((x) => normalizeInput(x) === n)!)
        .map((n) => ['skills', entry.name, n]);
      const info = notFoundError('skill', name, suggestions, name);
      info.next = `via skills ${shellWords(entry.name)}`;
      throw new CliFailure(info);
    }
    throw error;
  }
  if (!read.verified) app.err(`warning: ${app.redact.scan(`the manifest of skill ${visibleText(read.skill.frontmatter.name)} is "dynamic": the server publishes no sizes or digests, so ${visibleText(read.file.uri.slice(skillRoot(read.skill.uri).length + 1))} could not be checked`)}\n`);
  const code = await print(app, entry, ref, started, skillFileResult(safe(app, read), app.options.format));
  if (code === ExitCode.Ok && file === undefined && app.options.format === 'text') app.err(await app.redactText(filesHint(safe(app, read), entry.name)));
  return code;
}
