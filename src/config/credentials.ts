// Credential references (config.md, "凭证引用"; auth.md). Resolved in memory only, right before a
// connection is made. Nothing here writes a resolved value anywhere, and no error message contains one.

import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { CredentialError, type ConfigOrigin, type CredentialRef, type CredentialResolver } from './types';
import { expandPath, pathContext, type Env, type PathContext } from './paths';

export type CredentialKind = 'env' | 'file' | 'keychain' | 'cmd' | 'literal';

const PREFIXES = ['env', 'file', 'keychain', 'cmd'] as const;

/** Literals shorter than this are not added to the redaction list: replacing `1` or `on` everywhere would wreck output. */
export const MIN_REDACTED_LITERAL_LENGTH = 8;

/** Split a value into its reference kind and argument. Anything without a known prefix is a literal. */
export function parseCredentialRef(value: CredentialRef): { kind: CredentialKind; arg: string } {
  for (const kind of PREFIXES) {
    if (value.startsWith(`${kind}:`)) return { kind, arg: value.slice(kind.length + 1) };
  }
  return { kind: 'literal', arg: value };
}

export function isCredentialRef(value: CredentialRef): boolean {
  return parseCredentialRef(value).kind !== 'literal';
}

/** How long a `cmd:` credential command may run before it is killed (config.md, "凭证引用"). */
export const CMD_TIMEOUT_MS = 30_000;

/** How long a `cmd:` result is reused by one resolver (a daemon keeps its resolver; a CLI run is shorter than this). */
export const CMD_TTL_MS = 10 * 60_000;

/** Upper bound for what a credential command may print; anything larger is not a credential. */
export const CMD_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Split the argument of `cmd:` into argv. No shell is involved: words are separated by whitespace,
 * `'…'` is literal, `"…"` honours `\"` and `\\`, a backslash outside quotes escapes the next
 * character. Nothing is expanded (no `$VAR`, `~`, globs, pipes). Returns undefined for an empty
 * command or an unterminated quote. Users who want a shell write `cmd:sh -c '…'`.
 */
export function splitCommandLine(text: string): string[] | undefined {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else current += c;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) current += text[++i];
      else current += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < text.length) {
      current += text[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
    } else {
      current += c;
      inWord = true;
    }
  }
  if (quote !== undefined) return undefined;
  if (inWord) words.push(current);
  return words.length > 0 && words[0] !== '' ? words : undefined;
}

/** Minimal surface of `@napi-rs/keyring` that is used here. */
export interface KeyringModule {
  AsyncEntry: new (service: string, account: string) => { getPassword(): Promise<string | null> };
}

export interface CredentialResolverOptions {
  home?: string;
  env?: Env;
  platform?: NodeJS.Platform;
  /** Base for relative `file:` paths. Default: the current directory. */
  cwd?: string;
  /** Loader for the keychain module; the default imports `@napi-rs/keyring` on first use. */
  loadKeyring?: () => Promise<KeyringModule>;
  /** Kill a `cmd:` command after this long. Default: 30 seconds. */
  cmdTimeoutMs?: number;
  /** Reuse a `cmd:` result for this long; 0 runs the command on every resolve. Default: 10 minutes. */
  cmdTtlMs?: number;
  /** Clock for the `cmd:` cache. Default: `Date.now`. */
  now?: () => number;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function where(origin: ConfigOrigin): string {
  return origin.path ? ` (referenced in ${origin.path})` : '';
}

export function createCredentialResolver(options: CredentialResolverOptions = {}): CredentialResolver {
  const ctx: PathContext = pathContext(options);
  const cwd = options.cwd ?? process.cwd();
  const loadKeyring = options.loadKeyring ?? (async () => (await import('@napi-rs/keyring')) as unknown as KeyringModule);
  const values = new Set<string>();
  const cache = new Map<string, string>();
  const cmdTimeoutMs = options.cmdTimeoutMs ?? CMD_TIMEOUT_MS;
  const cmdTtlMs = options.cmdTtlMs ?? CMD_TTL_MS;
  const now = options.now ?? Date.now;
  const cmdCache = new Map<string, { value: string; expires: number }>();
  const cmdPending = new Map<string, Promise<string>>();

  function remember(value: string): string {
    values.add(value);
    return value;
  }

  async function resolveEnv(ref: string, name: string, origin: ConfigOrigin): Promise<string> {
    if (!ENV_NAME.test(name)) {
      throw new CredentialError(`invalid credential reference ${ref}: expected env:NAME`, ref, 'use a reference like env:EXA_API_KEY');
    }
    const value = ctx.env[name];
    if (value === undefined || value === '') {
      throw new CredentialError(`environment variable ${name} is not set${where(origin)}`, ref, `export ${name}=<value>, or point the reference at another source (file:, keychain:)`);
    }
    return value;
  }

  async function resolveFile(ref: string, arg: string, origin: ConfigOrigin): Promise<string> {
    if (arg === '') throw new CredentialError(`invalid credential reference ${ref}: expected file:PATH`, ref, 'use a reference like file:~/.secrets/exa');
    const expanded = expandPath(arg, ctx) ?? arg;
    const path = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new CredentialError(`credential file ${path} does not exist${where(origin)}`, ref, `create ${path} containing the credential, or change the reference`);
      }
      throw new CredentialError(`cannot read credential file ${path}: ${code ?? 'read error'}${where(origin)}`, ref, `check the permissions of ${path}`);
    }
    const value = text.trim();
    if (value === '') throw new CredentialError(`credential file ${path} is empty${where(origin)}`, ref, `write the credential into ${path}`);
    return value;
  }

  async function resolveKeychain(ref: string, arg: string, origin: ConfigOrigin): Promise<string> {
    const slash = arg.indexOf('/');
    const service = slash > 0 ? arg.slice(0, slash) : '';
    const account = slash > 0 ? arg.slice(slash + 1) : '';
    if (service === '' || account === '') {
      throw new CredentialError(`invalid credential reference ${ref}: expected keychain:service/account`, ref, 'use a reference like keychain:via/github');
    }
    let found: string | null;
    try {
      const { AsyncEntry } = await loadKeyring();
      found = await new AsyncEntry(service, account).getPassword();
    } catch (error) {
      // The platform error text is about the keychain, not the secret; keep only the first line.
      const reason = error instanceof Error ? error.message.split('\n')[0] : 'unknown error';
      throw new CredentialError(`cannot read the system keychain: ${reason}${where(origin)}`, ref, 'use env: or file: instead, or check that a keychain service is running');
    }
    if (found === null || found === '') {
      throw new CredentialError(`no keychain entry for service "${service}", account "${account}"${where(origin)}`, ref, `add it to the keychain (service "${service}", account "${account}"), or change the reference`);
    }
    return found;
  }

  /** `cmd:` is for the user config only; checked on every resolve, before any cached value is looked at. */
  function checkCmdOrigin(ref: string, origin: ConfigOrigin): void {
    if (origin.scope !== 'user' && origin.scope !== 'cli') {
      throw new CredentialError(`cmd: credential references are only allowed in the user config${where(origin)}`, ref, 'move this server definition to ~/.config/via/config.yaml, or use env:, file: or keychain:');
    }
  }

  /**
   * Run the command (no shell) and return its trimmed stdout. Neither stdout nor stderr ever reaches
   * an error message: a failing credential helper may well print the secret it was asked for.
   */
  async function runCmd(ref: string, arg: string, origin: ConfigOrigin): Promise<string> {
    const argv = splitCommandLine(arg);
    if (!argv) {
      throw new CredentialError('invalid cmd: credential reference: expected a command such as cmd:op read op://vault/item/field (empty command or unterminated quote)', ref, 'use a reference like cmd:op read op://dev/exa/key');
    }
    const [program, ...args] = argv as [string, ...string[]];
    const name = JSON.stringify(basename(program));
    const { spawn } = await import('node:child_process');
    return new Promise<string>((resolvePromise, reject) => {
      const fail = (message: string, next: string): void => reject(new CredentialError(`${message}${where(origin)}`, ref, next));
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(ctx.env)) if (value !== undefined) env[key] = value;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
      } catch (error) {
        fail(`cannot run credential command ${name}: ${(error as NodeJS.ErrnoException).code ?? 'spawn error'}`, 'check the command in the cmd: reference');
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let overflow = false;
      let settled = false;
      const timer = setTimeout(() => {
        // Do not wait for 'close': a grandchild may hold the pipes open after the child is gone.
        child.kill('SIGKILL');
        child.stdout?.destroy();
        finish(() => fail(`credential command ${name} did not finish within ${Math.round(cmdTimeoutMs / 1000)}s and was killed`, 'run the command by hand to see why it hangs (it may be waiting for a prompt)'));
      }, cmdTimeoutMs);
      function finish(action: () => void): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > CMD_MAX_OUTPUT_BYTES) {
          overflow = true;
          child.kill('SIGKILL');
        } else chunks.push(chunk);
      });
      child.stderr?.resume(); // drained and dropped
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          finish(() => fail(`credential command ${name} was not found`, 'install it, check PATH, or use env:, file: or keychain: instead'));
        } else {
          finish(() => fail(`cannot run credential command ${name}: ${error.code ?? 'spawn error'}`, 'check the command in the cmd: reference'));
        }
      });
      child.on('close', (code, signal) => {
        finish(() => {
          if (overflow) return fail(`credential command ${name} printed more than ${CMD_MAX_OUTPUT_BYTES / 1024} KiB; that is not a credential`, 'make the command print only the credential');
          if (code !== 0) {
            const how = signal ? `was killed by ${signal}` : `exited with status ${code}`;
            return fail(`credential command ${name} ${how} (its output is not shown)`, 'run the command by hand to see its error');
          }
          const value = Buffer.concat(chunks).toString('utf8').trim();
          if (value === '') return fail(`credential command ${name} printed nothing`, 'make the command print the credential on stdout');
          resolvePromise(value);
        });
      });
    });
  }

  async function resolveCmd(ref: string, arg: string, origin: ConfigOrigin): Promise<string> {
    checkCmdOrigin(ref, origin);
    const hit = cmdCache.get(ref);
    if (hit && hit.expires > now()) return hit.value;
    let pending = cmdPending.get(ref);
    if (!pending) {
      // Concurrent resolves of one reference (doctor probes servers in parallel) share one run.
      const started = runCmd(ref, arg, origin).then((value) => {
        if (cmdTtlMs > 0) cmdCache.set(ref, { value, expires: now() + cmdTtlMs });
        return value;
      });
      const clear = (): void => void cmdPending.delete(ref);
      started.then(clear, clear);
      cmdPending.set(ref, started);
      pending = started;
    }
    return remember(await pending);
  }

  return {
    async resolve(ref, origin) {
      const { kind, arg } = parseCredentialRef(ref);
      if (kind === 'literal') {
        if (ref.length >= MIN_REDACTED_LITERAL_LENGTH) remember(ref);
        return ref;
      }
      if (kind === 'cmd') return resolveCmd(ref, arg, origin);
      const cached = cache.get(ref);
      if (cached !== undefined) return cached;
      const value = kind === 'env' ? await resolveEnv(ref, arg, origin) : kind === 'file' ? await resolveFile(ref, arg, origin) : await resolveKeychain(ref, arg, origin);
      cache.set(ref, value);
      return remember(value);
    },
    resolvedValues() {
      return [...values];
    },
  };
}
