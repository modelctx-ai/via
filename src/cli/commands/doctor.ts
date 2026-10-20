// `via doctor`: probe every server live, then hand the results to the renderer.
import { BUNDLED_FRAMEWORKS, CredentialError } from '../../config';
import { ClientError } from '../../client';
import type { App } from '../app';
import { buildProviderTable, statusOf } from '../directory';
import { renderDoctor, type ServerProbe } from '../doctor';

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
        const { tools } = await app.listing(entry, { refresh: true, many: true });
        return { ...base, status: 'ok', toolCount: tools.length, schemaBytes: Buffer.byteLength(JSON.stringify(tools), 'utf8') };
      } catch (error) {
        const probe: ServerProbe = { ...base, status: statusOf(error), message: app.redact(error instanceof Error ? error.message : String(error)) };
        const next = error instanceof ClientError || error instanceof CredentialError ? error.next : undefined;
        if (next) probe.next = app.redact(next);
        return probe;
      }
    }),
  );

  const out = renderDoctor({ config, frameworks: BUNDLED_FRAMEWORKS, probes, catalogWarnings: table.warnings, home: app.io.home });
  app.out(`${out.text}\n`);
  return out.exitCode;
}
