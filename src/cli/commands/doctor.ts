// `via doctor`: probe every server live, then hand the results to the renderer.
import { BUNDLED_FRAMEWORKS, CredentialError, type ServerConfig } from '../../config';
import { shellArg, shellWord } from '../../render/shell';
import { ClientError } from '../../client/errors';
import type { App } from '../app';
import { buildProviderTable, statusOf } from '../directory';
import { describeProxy, proxySettings } from '../../proxy';
import { renderDoctor, type ServerProbe } from '../doctor';
import { SANDBOX_MARKER } from '../policy';
import { detectHost, windowsSidePaths } from '../../platform/host';
import { readFileSync } from 'node:fs';

export async function doctorCommand(app: App): Promise<number> {
  const config = await app.config({ allowErrors: true });
  const table = buildProviderTable(config.servers);
  const entryOf = new Map(table.entries.map((e) => [e.server, e]));
  const skipped = new Map(table.skipped.map((s, i) => [s, table.warnings[i]!.message]));

  const probes: ServerProbe[] = await Promise.all(
    config.servers.map(async (server): Promise<ServerProbe> => {
      const base = { server: server.name, provider: server.provider };
      if (server.disabled) return { ...base, status: 'disabled' };
      const entry = entryOf.get(server);
      if (!entry) return { ...base, status: 'error', message: skipped.get(server) ?? 'provider name is not usable' };
      try {
        const { tools, protocol } = await app.listing(entry, { refresh: true, many: true });
        const warning = await loginStoreWarning(app, server);
        return { ...base, status: 'ok', toolCount: tools.length, ...(protocol ? { protocol } : {}), schemaBytes: Buffer.byteLength(JSON.stringify(tools), 'utf8'), toolNameBytes: tools.reduce((n, t) => n + Buffer.byteLength(t.name, 'utf8'), 0), ...(warning ? { warning } : {}) };
      } catch (error) {
        const probe: ServerProbe = { ...base, status: probeStatus(statusOf(error)), message: app.redact.scan(error instanceof Error ? error.message : String(error)) };
        const next = nextFromDoctor(app, server, error instanceof ClientError || error instanceof CredentialError ? error.next : undefined);
        if (next) probe.next = app.redact.scan(next);
        return probe;
      }
    }),
  );

  const { logDir, logsSummary } = await import('../../log');
  const dir = logDir(app.cacheDir);
  const used = await logsSummary(dir);
  const host = detectHost({ platform: app.io.platform, env: app.io.env, readProcVersion });
  // Framework and via config files on the Windows side of WSL: the servers' origins and every loaded file.
  const windowsSideFiles = windowsSidePaths([...config.files.map((f) => f.path), ...config.servers.map((s) => s.origin.path)]);
  const out = renderDoctor({
    config,
    frameworks: BUNDLED_FRAMEWORKS,
    probes,
    catalogWarnings: table.warnings,
    home: app.io.home,
    env: app.io.env,
    proxy: describeProxy(proxySettings(app.io.env)),
    logs: { dir, ...(used ?? {}) },
    host: { kind: host, windowsSideFiles },
    sandboxed: app.io.env[SANDBOX_MARKER] === '1',
  });
  app.out(`${out.text}\n`);
  return out.exitCode;
}

/**
 * `via doctor` is what a failure that may pass on its own points at (output.md, "错误"), and that is the
 * command being run: here the next step is the server's own log, unless the config hides `via daemon`.
 */
function nextFromDoctor(app: App, server: ServerConfig, next: string | undefined): string | undefined {
  if (next !== 'via doctor') return next;
  return app.commandVisible('daemon') ? `via daemon logs ${shellArg(server.provider, { placeholder: 'provider', positional: true })}` : undefined;
}

/**
 * A refreshed OAuth login that cannot be saved is used by one process only, and a server that
 * rotates refresh tokens then rejects the one left in the store (auth.md, "刷新"). Looks at where
 * the saved login lives; the keychain is not probed.
 */
async function loginStoreWarning(app: App, server: ServerConfig): Promise<ServerProbe['warning']> {
  if (server.auth.type !== 'oauth') return undefined;
  try {
    const { oauthKey, oauthTarget, checkStoreWritable } = await import('../../client/oauth');
    const target = oauthTarget(server);
    if (!target) return undefined;
    const stored = await (await app.oauthStore()).get(oauthKey(target));
    if (!stored?.record.tokens) return undefined;
    const blocked = await checkStoreWritable(stored.location);
    if (!blocked) return undefined;
    return {
      message: `the OAuth login ${blocked.what} ${blocked.path} is not writable; a refreshed token cannot be saved`,
      next: `chmod u+w ${shellWord(blocked.path)}`,
    };
  } catch {
    return undefined;
  }
}

/** `/proc/version` on Linux; undefined anywhere it cannot be read (not Linux, no procfs, no permission). */
function readProcVersion(): string | undefined {
  try {
    return readFileSync('/proc/version', 'utf8');
  } catch {
    return undefined;
  }
}

/** `via doctor` has no `starting`: a probe that ran out of time is a finding (its message says so). */
function probeStatus(status: ReturnType<typeof statusOf>): ServerProbe['status'] {
  return status === 'failed' || status === 'starting' ? 'error' : status;
}
