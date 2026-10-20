// Diagnostics collected while loading configuration. A bad file never throws: it is skipped and
// reported here, for `via doctor` and the `via servers` warnings.

export type DiagnosticLevel = 'error' | 'warning' | 'info';

export type DiagnosticCode =
  | 'file-unreadable'
  | 'file-malformed'
  | 'file-missing'
  | 'invalid-field'
  | 'unknown-field'
  | 'invalid-server'
  | 'server-undefined'
  | 'cmd-forbidden'
  | 'search-forbidden'
  | 'invalid-deny'
  | 'unknown-source'
  | 'unexpanded-variable'
  | 'legacy-transport'
  | 'plaintext-credential'
  | 'trust-store-corrupt';

export interface ConfigDiagnostic {
  level: DiagnosticLevel;
  code: DiagnosticCode;
  /** Never contains a credential value. Field problems read `servers.github.timeout: expected number`. */
  message: string;
  /** The file the problem is in; absent for CLI overrides. */
  file?: string;
  /** The server the problem belongs to, when there is one. */
  server?: string;
}

export function hasErrors(diagnostics: readonly ConfigDiagnostic[]): boolean {
  return diagnostics.some((d) => d.level === 'error');
}

/** `file: message`, the one-line form used by `via doctor`. */
export function formatDiagnostic(d: ConfigDiagnostic): string {
  return d.file ? `${d.file}: ${d.message}` : d.message;
}
