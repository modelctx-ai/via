// The grammar of credential references (config.md, "凭证引用"): which prefix a value has. Config
// loading needs this on every run; the resolver that acts on it (credentials.ts) is a larger module
// that only a run which resolves a reference loads.

import type { CredentialRef } from './types';

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
