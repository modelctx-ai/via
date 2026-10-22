// A credential resolver that loads the real one (credentials.ts, with its `cmd:`, `file:` and
// keychain code) when the first reference is resolved. Most servers need no credential and a cached
// browse then resolves nothing, so such a run never reads that module.

import { MIN_REDACTED_LITERAL_LENGTH } from './credential-ref';
import type { CredentialResolverOptions } from './credentials';
import type { CredentialResolver } from './types';

export function createLazyCredentialResolver(options: CredentialResolverOptions = {}): CredentialResolver {
  let real: CredentialResolver | undefined;
  let loading: Promise<CredentialResolver> | undefined;
  // Secrets added by `track` before the resolver exists; handed over when it does.
  const early = new Set<string>();
  return {
    async resolve(ref, origin) {
      loading ??= import('./credentials').then(({ createCredentialResolver }) => {
        const made = createCredentialResolver(options);
        for (const value of early) made.track?.(value);
        real = made;
        return made;
      });
      return (await loading).resolve(ref, origin);
    },
    resolvedValues() {
      return real ? real.resolvedValues() : [...early];
    },
    track(value) {
      if (real) real.track?.(value);
      else if (value.length >= MIN_REDACTED_LITERAL_LENGTH) early.add(value);
    },
  };
}
