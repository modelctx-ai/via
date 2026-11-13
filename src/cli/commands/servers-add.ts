// `via servers add` (cli.md, "via servers add"; ADR 0032): one server written into the user's via
// config, after a person at a terminal has seen what will be written and said yes. It is the only
// place where via changes its own configuration, so everything here is refused rather than guessed:
// a token instead of a reference to one, a name that is taken, a file that does not parse.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalizeProviderName, RESERVED_COMMANDS } from '../../catalog';
import { isCredentialRef } from '../../config/credential-ref';
import { pathContext, shortenHome, userConfigPath } from '../../config/paths';
import { SANDBOX_MARKER } from '../../config/policy';
import { askToRun, askUser } from '../../render/ask';
import { ExitCode } from '../../render/exit-codes';
import { shellWords, visibleText } from '../../render/shell';
import type { App } from '../app';
import { fail, usageFailure } from '../failure';

export const ADD_USAGE =
  'usage: via servers add <name> <url> [--bearer <ref> | --oauth] [--header <Name>=<value>]…\n' +
  '       via servers add <name> [--env <KEY>=<value>]… -- <command> [args…]\n' +
  '  <ref> is env:NAME, keychain:<service>/<account>, file:<path> or cmd:<command>, never the secret itself\n' +
  '  asks for confirmation at a terminal; --dry-run shows what would be written';

const NEXT = 'via servers -h';
/** A server name that needs no quoting as a YAML key and reads the same as a provider on the command line. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
/** The names `via doctor` reports as plaintext secrets when their value is not a reference (doctor.ts). */
const SECRET_KEY = /KEY|TOKEN|SECRET|PASSW(?:OR)?D|AUTH|CREDENTIAL/i;
const REFERENCE_FORMS = 'env:NAME, keychain:<service>/<account>, file:<path> or cmd:<command>';

interface Parsed {
  name: string;
  url?: string;
  command?: string[];
  bearer?: string;
  oauth: boolean;
  headers: Array<[string, string]>;
  env: Array<[string, string]>;
}

function usage(message: string): never {
  throw usageFailure(`via servers add: ${message}`, NEXT, [ADD_USAGE]);
}

/** `KEY=value`, split at the first `=`. The value is never echoed: it may be the secret this command refuses. */
function pair(option: string, text: string | undefined): [string, string] {
  if (text === undefined) return usage(`${option} needs <name>=<value>`);
  const eq = text.indexOf('=');
  if (eq <= 0) return usage(`${option} needs <name>=<value>`);
  return [text.slice(0, eq), text.slice(eq + 1)];
}

function parse(argv: readonly string[]): Parsed {
  const split = argv.indexOf('--');
  const head = split < 0 ? argv : argv.slice(0, split);
  const command = split < 0 ? undefined : argv.slice(split + 1);
  const positionals: string[] = [];
  const out: Parsed = { name: '', oauth: false, headers: [], env: [] };
  for (let i = 0; i < head.length; i += 1) {
    const token = head[i]!;
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const key = eq > 0 ? token.slice(0, eq) : token;
    const value = (): string | undefined => (eq > 0 ? token.slice(eq + 1) : head[++i]);
    if (key === '--oauth' && eq < 0) out.oauth = true;
    else if (key === '--bearer') {
      const ref = value();
      if (ref === undefined || ref === '') usage('--bearer needs a credential reference');
      out.bearer = ref;
    } else if (key === '--header') out.headers.push(pair('--header', value()));
    else if (key === '--env') out.env.push(pair('--env', value()));
    else usage(`unknown option ${visibleText(key.slice(0, 40))}`);
  }
  if (positionals.length === 0) usage('a name is required');
  out.name = positionals[0]!;
  if (command !== undefined) {
    if (command.length === 0) usage('a command is required after --');
    if (positionals.length > 1) usage('give a URL or a command after --, not both');
    out.command = [...command];
  } else {
    if (positionals.length === 1) usage('a URL, or a command after --, is required');
    if (positionals.length > 2) usage(`unexpected argument ${JSON.stringify(visibleText(positionals[2]!.slice(0, 40)))} (a command goes after --)`);
    out.url = positionals[1]!;
  }
  return out;
}

/** A value under a name that looks like a secret must be a reference: what `via doctor` would flag is never written. */
function checkValue(option: string, name: string, value: string): void {
  if (value === '') usage(`${option} ${visibleText(name)} has no value`);
  if (SECRET_KEY.test(name) && !isCredentialRef(value)) {
    usage(`${option} ${visibleText(name)} looks like a secret: give a reference to it (${REFERENCE_FORMS}), never the value itself`);
  }
}

/** Everything that can be decided from the command line alone. Throws a usage failure; echoes no value that may be a secret. */
function validate(p: Parsed): void {
  if (!NAME.test(p.name) || normalizeProviderName(p.name) === '') usage('the name may hold letters, digits, ".", "_" and "-", and starts with a letter or digit');
  if (RESERVED_COMMANDS.includes(normalizeProviderName(p.name))) usage(`${p.name} is the name of a via command; choose another name`);
  if (p.url !== undefined) {
    if (p.env.length > 0) usage('--env is for a command (after --); an HTTP server takes --header');
    if (p.bearer !== undefined && p.oauth) usage('--bearer and --oauth cannot be combined');
    let url: URL;
    try {
      url = new URL(p.url);
    } catch {
      return usage('the URL does not parse (a command goes after --)');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') usage('the URL must be http or https');
    if (url.username !== '' || url.password !== '') usage('credentials do not go into the URL: use --bearer or --header with a reference');
    for (const key of url.searchParams.keys()) {
      if (SECRET_KEY.test(key)) usage(`the URL carries ${visibleText(key.slice(0, 40))} in its query: a secret does not go into the config; use --bearer or --header with a reference`);
    }
    if (p.bearer !== undefined && !isCredentialRef(p.bearer)) {
      usage(`--bearer takes a reference to the token (${REFERENCE_FORMS}), never the token itself`);
    }
    for (const [name, value] of p.headers) {
      if (!HEADER_NAME.test(name)) usage('a header name holds letters, digits and "-"');
      checkValue('--header', name, value);
    }
  } else {
    if (p.bearer !== undefined || p.oauth || p.headers.length > 0) usage('--bearer, --oauth and --header are for an HTTP server; a command takes --env');
    for (const [name, value] of p.env) {
      if (!ENV_KEY.test(name)) usage('an environment variable name holds letters, digits and "_"');
      checkValue('--env', name, value);
    }
  }
}

/** The entry as it goes under `servers.<name>`, keys in the order a person would write them. */
function entryOf(p: Parsed): Record<string, unknown> {
  if (p.url !== undefined) {
    return {
      url: p.url,
      ...(p.oauth ? { auth: 'oauth' } : p.bearer !== undefined ? { auth: { bearer: p.bearer } } : {}),
      ...(p.headers.length > 0 ? { headers: Object.fromEntries(p.headers) } : {}),
    };
  }
  const [command, ...args] = p.command!;
  return { command, ...(args.length > 0 ? { args } : {}), ...(p.env.length > 0 ? { env: Object.fromEntries(p.env) } : {}) };
}

/** The file to write: a symbolic link (a dotfiles checkout) is followed, so the link stays and its target changes. */
function targetOf(path: string): string {
  try {
    return lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

/** Same JSON value, whatever the order of the keys. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => k in b && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

type Yaml = typeof import('yaml');

/**
 * The file with the server added. The entry's lines are put into the text where the `servers`
 * block ends (or a `servers` block is appended), so every other byte, comments and spacing included,
 * stays as the person wrote it. Where the text has no such place (`servers: {}`, an empty
 * `servers:`), the document is written out again by the YAML library, which keeps the comments but
 * not always their placement. Either way the result is parsed and compared before it is returned:
 * it holds what the file held, plus this server, or nothing is written.
 */
function withServer(yaml: Yaml, source: string, name: string, entry: Record<string, unknown>): string {
  const doc = yaml.parseDocument(source, { prettyErrors: false });
  const before = (doc.toJS({ maxAliasCount: 100 }) ?? {}) as Record<string, unknown>;
  const wanted = { ...before, servers: { ...((before.servers as Record<string, unknown> | null | undefined) ?? {}), [name]: entry } };
  const holds = (text: string): boolean => {
    const again = yaml.parseDocument(text, { prettyErrors: false });
    return again.errors.length === 0 && same(again.toJS({ maxAliasCount: 100 }), wanted);
  };
  const lines = (indent: string, value: unknown): string =>
    yaml
      .stringify(value)
      .trimEnd()
      .split('\n')
      .map((line) => `${indent}${line}\n`)
      .join('');

  const servers = doc.get('servers', true);
  let text: string | undefined;
  if (yaml.isMap(servers) && !servers.flow && servers.items.length > 0 && servers.range) {
    const first = (servers.items[0]!.key as { range?: [number, number, number] } | null)?.range?.[0];
    if (first !== undefined) {
      const indent = source.slice(source.lastIndexOf('\n', first - 1) + 1, first);
      const at = servers.range[1];
      if (/^[ ]*$/.test(indent)) text = `${source.slice(0, at)}${source.slice(0, at).endsWith('\n') ? '' : '\n'}${lines(indent, { [name]: entry })}${source.slice(at)}`;
    }
  } else if (!doc.has('servers')) {
    text = `${source}${source === '' || source.endsWith('\n') ? '' : '\n'}${lines('', { servers: { [name]: entry } })}`;
  }
  if (text !== undefined && holds(text)) return text;

  // An empty `servers:` holds a null, which is replaced; a mapping takes one more entry.
  if (yaml.isMap(servers)) doc.setIn(['servers', name], doc.createNode(entry));
  else doc.set('servers', doc.createNode({ [name]: entry }));
  const rewritten = doc.toString();
  if (!holds(rewritten)) throw new Error('the configuration could not be extended without changing what it says');
  return rewritten;
}

export async function serversAddCommand(app: App, argv: readonly string[]): Promise<number> {
  const parsed = parse(argv);
  validate(parsed);
  const { name } = parsed;
  const ctx = pathContext({ home: app.io.home, env: app.io.env, platform: app.io.platform });
  const path = userConfigPath(ctx);
  const shown = visibleText(shortenHome(path, app.io.home, app.io.platform));

  // Loading runs nothing; an error elsewhere in the configuration must not hide that the name is free.
  const config = await app.config({ allowErrors: true });
  const wanted = normalizeProviderName(name);
  const taken = config.servers.find((s) => s.name === name || normalizeProviderName(s.provider) === wanted || normalizeProviderName(s.name) === wanted);
  if (taken) {
    const where = taken.origin.path ? visibleText(shortenHome(taken.origin.path, app.io.home, app.io.platform)) : taken.origin.scope;
    throw fail(ExitCode.Usage, `via servers add: ${visibleText(taken.name)} is already defined in ${where}`, 'via servers', [
      `to change it, or to add credentials to it, edit servers.${visibleText(taken.name)} in ${shown}`,
    ]);
  }

  // In the bundle a CommonJS package has only `default` (config/parse.ts).
  const loaded = await import('yaml');
  const yaml = (loaded as unknown as { default?: Yaml }).default ?? loaded;
  const { parseDocument, stringify, isMap, isScalar } = yaml;
  const target = targetOf(path);
  const exists = existsSync(target);
  const source = exists ? readFileSync(target, 'utf8') : '';
  const doc = parseDocument(source, { prettyErrors: false });
  if (doc.errors.length > 0) {
    throw fail(ExitCode.Usage, `via servers add: ${shown} is not valid YAML (${doc.errors[0]!.code}); nothing was written`, 'via doctor');
  }
  if (doc.contents !== null && !isMap(doc.contents)) throw fail(ExitCode.Usage, `via servers add: ${shown} is not a mapping; nothing was written`, 'via doctor');
  const servers = doc.get('servers', true);
  const none = servers === undefined || servers === null || (isScalar(servers) && servers.value === null);
  if (!none && !isMap(servers)) throw fail(ExitCode.Usage, `via servers add: servers in ${shown} is not a mapping; nothing was written`, 'via doctor');
  // A server of that name which is disabled, or left out for an error, is still in the file.
  if (doc.hasIn(['servers', name])) {
    throw fail(ExitCode.Usage, `via servers add: ${name} is already in ${shown}`, 'via servers', [`edit servers.${name} there`]);
  }

  const entry = entryOf(parsed);
  // What will be written, as it will look: the person confirms this text, not a description of it.
  const block = stringify({ servers: { [name]: entry } }).trimEnd().split('\n');
  app.out(`${shown}${exists ? '' : '  (new file)'}\n${block.map((line) => `+ ${visibleText(line)}`).join('\n')}\n`);

  if (app.options.dryRun) {
    app.err('· dry run: nothing was written\n');
    return ExitCode.Ok;
  }
  const again = `via ${shellWords(['servers', 'add', ...argv])}`;
  if (app.io.env[SANDBOX_MARKER] === '1') {
    throw fail(ExitCode.Denied, 'the server was not added: via runs in its sandbox, which keeps the via configuration read-only', askUser(`run it outside the sandbox (list servers under sandbox.exclude), or add the lines above to ${shown}`));
  }
  if (!app.io.interactive) throw fail(ExitCode.Denied, 'the server was not added: confirmation needs a terminal', askToRun(again));
  const answer = (await app.io.ask(`add this server to ${shown}? [y/N] `)).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') throw fail(ExitCode.Denied, 'the server was not added', again);

  let text: string;
  try {
    text = withServer(yaml, source, name, entry);
  } catch (error) {
    throw fail(ExitCode.Internal, `via servers add: ${(error as Error).message}; nothing was written`, askUser(`add the lines above to ${shown}`));
  }
  mkdirSync(dirname(target), { recursive: true });
  // Written beside the file and renamed over it: a crash leaves the old file or the new one, never half of one.
  const temporary = join(dirname(target), `.config.yaml.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, text, { mode: exists ? statSync(target).mode & 0o777 : 0o600, flag: 'w' });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw fail(ExitCode.Internal, `via servers add: cannot write ${shown}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`, askUser(`add the lines above to ${shown}`));
  }
  app.err(`· added ${name} to ${shown}\n`);
  app.out(parsed.oauth ? `→ via auth login ${name} to sign in\n` : `→ via ${name} to see its tools\n`);
  return ExitCode.Ok;
}
