// Before any trial: the mounted servers that the user has configured with credentials must
// already be usable. OAuth that still needs a browser is started here, once, and checked again.
// Servers with no credentials are the replay-only ones and are left alone.
import type { ExecResult } from '../harness/exec';

export interface AuthStatusRow {
  provider: string;
  method: string;
  state: string;
}

/** An OAuth server that will not refresh on its own and needs `via auth login` before the run. */
export function needsInteractiveLogin(row: AuthStatusRow): boolean {
  if (row.method !== 'oauth') return false;
  if (row.state.startsWith('logged in')) return false;
  if (row.state.includes('refreshes on next call')) return false;
  if (row.state.startsWith('client credentials') && !row.state.includes('missing')) return false;
  return true;
}

/** A configured credential that a call could not use. `none` is not a failure: the replay server needs nothing. */
export function authUnusable(row: AuthStatusRow): boolean {
  if (row.method === 'none') return false;
  if (row.method === 'oauth') return needsInteractiveLogin(row) || row.state.startsWith('cannot read') || row.state.includes('missing');
  return row.state.startsWith('missing');
}

export async function preflightAuth(options: {
  /** Mounted server names. Only those present in `via auth status` are checked. */
  providers: readonly string[];
  run: (args: string[]) => Promise<ExecResult>;
  log: (line: string) => void;
}): Promise<void> {
  const listed = await options.run(['auth', 'status', '-o', 'json']);
  if (listed.code !== 0) throw new Error(`preflight: via auth status failed: ${(listed.stderr || listed.stdout).trim()}`);
  const rows = JSON.parse(listed.stdout) as AuthStatusRow[];
  const byName = new Map(rows.map((row) => [row.provider, row]));
  for (const name of options.providers) {
    const row = byName.get(name);
    if (row === undefined || row.method === 'none') {
      options.log(`preflight: ${name} has no credentials; the eval uses its local replay server`);
      continue;
    }
    let current = row;
    if (needsInteractiveLogin(current)) {
      options.log(`preflight: logging in to ${name}; approve the browser prompt`);
      const login = await options.run(['auth', 'login', name]);
      if (login.code !== 0) throw new Error(`preflight: via auth login ${name} failed: ${(login.stderr || login.stdout).trim()}`);
      const again = await options.run(['auth', 'status', name, '-o', 'json']);
      if (again.code !== 0) throw new Error(`preflight: via auth status ${name} failed: ${(again.stderr || again.stdout).trim()}`);
      const fresh = (JSON.parse(again.stdout) as AuthStatusRow[]).find((item) => item.provider === name);
      if (fresh === undefined) throw new Error(`preflight: ${name} disappeared from via auth status`);
      current = fresh;
    }
    if (authUnusable(current)) throw new Error(`preflight: ${name} is not usable (${current.state})`);
    options.log(`preflight: ${name} ok (${current.state})`);
  }
}
