// Credential references (config.md, "凭证引用"; auth.md). Resolved in memory only, right before a
// connection is made. Nothing here writes a resolved value anywhere, and no error message contains one.

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
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

  function resolveCmd(ref: string, origin: ConfigOrigin): never {
    if (origin.scope !== 'user' && origin.scope !== 'cli') {
      throw new CredentialError(`cmd: credential references are only allowed in the user config${where(origin)}`, ref, 'move this server definition to ~/.config/via/config.yaml, or use env:, file: or keychain:');
    }
    throw new CredentialError('cmd: credential references are not supported yet (planned for 0.2)', ref, 'use env:, file: or keychain: for now');
  }

  return {
    async resolve(ref, origin) {
      const { kind, arg } = parseCredentialRef(ref);
      if (kind === 'literal') {
        if (ref.length >= MIN_REDACTED_LITERAL_LENGTH) remember(ref);
        return ref;
      }
      if (kind === 'cmd') return resolveCmd(ref, origin);
      const cached = cache.get(ref);
      if (cached !== undefined) return cached;
      const value = kind === 'env' ? await resolveEnv(ref, arg, origin) : kind === 'file' ? await resolveFile(ref, arg, origin) : await resolveKeychain(ref, arg, origin);
      cache.set(ref, value);
      return remember(value);
    },
    resolvedValues() {
      return [...values];
    },
    track(value) {
      if (value.length >= MIN_REDACTED_LITERAL_LENGTH) values.add(value);
    },
  };
}
