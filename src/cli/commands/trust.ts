// `via trust [<path>] [--dry-run] [--yes]`, `via trust --list`, `via trust --revoke <path>`
// (security.md, "项目级配置的信任"). Shows what a project-level file would let via start or contact
// (commands, URLs, the names of env variables and headers; never their values), then records the
// file's real path and the SHA-256 of the bytes that were parsed and shown.
import { readFileSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import {
  forgetTrust,
  hashContent,
  parseCredentialRef,
  pathContext,
  readTrustStore,
  recordTrustHash,
  splitCommandLine,
  trustKey,
  trustStatus,
  userDataDir,
  type LoadedFile,
  type ServerConfig,
  type TrustStore,
} from '../../config';
import { ExitCode } from '../../render/exit-codes';
import { shortenHome } from '../../config/paths';
import { inertText, shellQuote, shellWord } from '../../render/shell';
import { alignRows } from '../../render/width';
import type { App } from '../app';
import { fail, usageFailure } from '../failure';
import { parseLocal } from '../options';

const TRUST_USAGE =
  'usage: via trust [<path>] [--dry-run] | via trust <path> --yes (scripts only: needs VIA_ALLOW_NONINTERACTIVE_TRUST=1) | via trust --list | via trust --revoke <path>';
const USAGE = TRUST_USAGE;

/** `--yes` is only honored with an explicit path and this opt-in (security.md, "via trust"). */
const NONINTERACTIVE_OPT_IN = 'VIA_ALLOW_NONINTERACTIVE_TRUST';

const SHORT_HASH = 12;

/** Keep what a hostile file could use to forge the display (control characters, bidi marks) out of it. */
function safe(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * One word of a command line, quoted the way the shell would need it so that spaces stay visible;
 * one that no quoting can carry safely is shown as an inert escaped string instead.
 */
function word(text: string): string {
  return shellQuote(text) ?? inertText(text);
}

/** A root directory as written in the config (`~/notes` stays as typed); quoted like a word when it has spaces or the like. */
function rootWord(text: string): string {
  return /^[\w@%+=:,./\\~-]+$/.test(text) ? text : word(text);
}

const shorten = (path: string, home: string): string => shortenHome(path, home);

/** `https://host/path`; the query string, fragment and userinfo are hidden since they often carry a token. */
function describeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const hidden = [url.username || url.password ? 'userinfo' : '', url.search ? 'query' : ''].filter(Boolean);
    return `${url.protocol}//${url.host}${safe(url.pathname)}${hidden.length > 0 ? ` (${hidden.join(' and ')} hidden)` : ''}`;
  } catch {
    return '(not a valid URL)';
  }
}

/**
 * The reference (`env:EXA_KEY`), or `(literal)`: where a value comes from, never the value. For
 * `cmd:` only the program is shown, since its arguments may carry a secret of their own.
 */
function describeRef(value: string): string {
  const { kind, arg } = parseCredentialRef(value);
  if (kind === 'literal') return '(literal)';
  if (kind === 'cmd') return `cmd:${safe(basename(splitCommandLine(arg)?.[0] ?? ''))} …`;
  return safe(value);
}

/** `NAME=env:EXA_KEY, OTHER=(literal)`: literal values are never printed, they may be credentials. */
function describeEntries(entries: Readonly<Record<string, string>>): string {
  return Object.entries(entries)
    .map(([key, value]) => `${safe(key)}=${describeRef(value)}`)
    .join(', ');
}

/** What the server would do once trusted, as indented lines under its name. */
function describeServer(server: ServerConfig): string[] {
  const { transport, auth } = server;
  const lines: string[] = [];
  if (transport.type === 'stdio') {
    lines.push(`  ${safe(server.provider)}  stdio  ${[transport.command, ...transport.args].map(word).join(' ')}`);
    if (transport.cwd !== undefined) lines.push(`      cwd: ${word(transport.cwd)}`);
    if (Object.keys(transport.env).length > 0) lines.push(`      env: ${describeEntries(transport.env)}`);
  } else {
    lines.push(`  ${safe(server.provider)}  http  ${describeUrl(transport.url)}`);
    if (Object.keys(transport.headers).length > 0) lines.push(`      headers: ${describeEntries(transport.headers)}`);
  }
  // Directories the server is told it may work in: part of what is being trusted (ADR 0010).
  if (server.roots !== undefined && server.roots.length > 0) lines.push(`      roots: ${server.roots.map(rootWord).join(', ')}`);
  if (auth.type === 'bearer') lines.push(`      auth.bearer: ${describeRef(auth.bearer)}`);
  if (auth.type === 'headers') lines.push(`      auth.headers: ${describeEntries(auth.headers)}`);
  return lines;
}

interface Target {
  file: LoadedFile;
  status: 'untrusted' | 'changed' | 'trusted';
  servers: ServerConfig[];
}

function targetsOf(files: readonly LoadedFile[], servers: readonly ServerConfig[], store: TrustStore): Target[] {
  const out: Target[] = [];
  for (const file of files) {
    if (file.scope !== 'project' && file.scope !== 'framework-project') continue;
    const dependent = servers.filter((s) => s.launchPaths?.includes(file.path));
    if (dependent.length === 0) continue;
    out.push({ file, status: trustStatus(store, file.path, file.sha256), servers: dependent });
  }
  return out;
}

export async function trustCommand(app: App, argv: readonly string[]): Promise<number> {
  const { flags, positionals } = parseLocal('trust', argv, [
    { name: 'list', value: false },
    { name: 'revoke', value: false },
  ]);
  const ctx = pathContext({ home: app.io.home, env: app.io.env, platform: app.io.platform });
  const dataDir = userDataDir(ctx);
  const absolute = (p: string): string => (isAbsolute(p) ? p : resolve(app.io.cwd, p));

  if (flags.list && flags.revoke) throw usageFailure('via trust: --list and --revoke cannot be combined', 'via trust -h', [USAGE]);
  if (flags.list) {
    if (positionals.length > 0) throw usageFailure(USAGE, 'via trust -h');
    return listRecords(app, dataDir);
  }
  if (flags.revoke) {
    if (positionals.length !== 1) throw usageFailure(USAGE, 'via trust -h');
    const path = absolute(positionals[0]!);
    if (!forgetTrust(dataDir, path)) throw fail(ExitCode.NotFound, `no trust record for ${path}`, 'via trust --list');
    app.err(`· revoked ${shorten(trustKey(path), app.io.home)}\n`);
    return ExitCode.Ok;
  }
  if (positionals.length > 1) throw usageFailure(USAGE, 'via trust -h');
  if (app.options.yes && !app.options.dryRun) {
    // Whoever runs `via trust --yes` decides for the user, so it is not a one-flag shortcut: an
    // explicit path, and the opt-in the user sets for their own scripts, are both required.
    if (positionals.length === 0) throw usageFailure('via trust: --yes needs an explicit <path>', 'via trust -h', [USAGE]);
    if (app.io.env[NONINTERACTIVE_OPT_IN] !== '1') {
      throw fail(ExitCode.Denied, 'trust was not recorded: --yes is disabled unless the user opts in to non-interactive trust (see via trust -h)', `ask the user to run this in a terminal: via trust ${shellWord(positionals[0]!)}`);
    }
  }

  // Loading executes nothing; an error-level diagnostic must not stop the person from trusting.
  const config = await app.config({ allowErrors: true });
  const { store, error } = readTrustStore(dataDir);
  if (error) app.err(`warning: ${error}\n`);
  const all = targetsOf(config.files, config.servers, store);

  let targets: Target[];
  if (positionals[0] !== undefined) {
    const key = trustKey(absolute(positionals[0]));
    const file = config.files.find((f) => (f.scope === 'project' || f.scope === 'framework-project') && trustKey(f.path) === key);
    if (!file) {
      throw fail(ExitCode.Usage, `${positionals[0]} is not a project-level config file loaded from ${app.io.cwd}`, 'via trust', [
        'run it from the project directory; without a path via trust lists the files waiting for confirmation',
      ]);
    }
    const target = all.find((t) => t.file === file);
    if (!target) {
      app.out(`${shorten(file.path, app.io.home)}: no server definition in this file needs trust\n`);
      return ExitCode.Ok;
    }
    targets = [target];
  } else {
    targets = all.filter((t) => t.status !== 'trusted');
    if (targets.length === 0) {
      app.out(all.length === 0 ? 'no project-level config needs trust\n' : `nothing to trust: ${all.length === 1 ? 'the project-level file is' : `all ${all.length} project-level files are`} already trusted\n`);
      return ExitCode.Ok;
    }
  }

  const pending = targets.filter((t) => t.status !== 'trusted');
  app.out(`${render(targets, app.io.home)}\n`);
  if (pending.length === 0) return ExitCode.Ok;

  if (app.options.dryRun) {
    app.err('· dry run: nothing was recorded\n');
    return ExitCode.Ok;
  }
  if (!app.options.yes) {
    if (!app.io.interactive) {
      throw fail(ExitCode.Denied, 'trust was not recorded: confirmation needs a terminal', `ask the user to run this in a terminal: via trust${pending.length === 1 ? ` ${shellWord(pending[0]!.file.path)}` : ''}`);
    }
    const answer = (await app.io.ask(`trust ${pending.length === 1 ? 'this file' : `these ${pending.length} files`}? [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') throw fail(ExitCode.Denied, 'trust was not recorded', 'via trust');
  }
  for (const target of pending) {
    recordTrustHash(dataDir, target.file.path, target.file.sha256, () => new Date(app.io.now()));
    const names = target.servers.map((s) => s.provider);
    app.err(`· trusted ${shorten(trustKey(target.file.path), app.io.home)} · sha256 ${target.file.sha256.slice(0, SHORT_HASH)} · ${names.join(', ')}\n`);
  }
  return ExitCode.Ok;
}

function render(targets: readonly Target[], home: string): string {
  const blocks = targets.map((t) => {
    const state = t.status === 'trusted' ? 'already trusted' : t.status === 'changed' ? 'changed since it was trusted' : 'not trusted';
    const head = `${safe(shorten(t.file.path, home))}  ${state}  sha256 ${t.file.sha256.slice(0, SHORT_HASH)}`;
    return [head, ...t.servers.flatMap(describeServer)].join('\n');
  });
  return blocks.join('\n\n');
}

function listRecords(app: App, dataDir: string): number {
  const { store, error } = readTrustStore(dataDir);
  if (error) app.err(`warning: ${error}\n`);
  const rows = Object.entries(store.entries).map(([path, record]) => {
    let state: string;
    try {
      state = hashContent(readFileSync(path)) === record.sha256 ? 'trusted' : 'changed';
    } catch {
      state = 'missing';
    }
    return [state, safe(shorten(path, app.io.home)), record.sha256.slice(0, SHORT_HASH), record.trustedAt.slice(0, 10)];
  });
  app.out(rows.length === 0 ? 'no trust records\n' : `${alignRows(rows.sort((a, b) => a[1]!.localeCompare(b[1]!))).join('\n')}\n`);
  return ExitCode.Ok;
}
