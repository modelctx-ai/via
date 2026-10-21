// The protocol version of a server, shown and pinnable (cli.md `via servers` / `via doctor`, config.md
// `protocolVersion`), against a server of each protocol generation.
import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN, ghConfig, makeSandbox, startFixtureServer, useCleanup, type Generation } from './helpers';

async function setup(generation: Generation, extra = '') {
  const srv = await startFixtureServer({ token: FAKE_TOKEN, protocol: generation });
  useCleanup(() => srv.close());
  const sb = makeSandbox({ GH_TOKEN: FAKE_TOKEN });
  sb.userConfig(ghConfig(srv.url, extra));
  return { srv, sb };
}

const SERVERS_LINE = /^gh +http http:\/\/127\.0\.0\.1:\d+ +(.+?) +bearer/m;
const protocolColumn = (stdout: string): string | undefined => SERVERS_LINE.exec(stdout)?.[1];

describe.each([
  ['modern', '2026-07-28 stateless'],
  ['legacy', '2025-11-25 stateless'], // the HTTP fixture hands out no session id
] as const)('a %s server', (generation, label) => {
  it('is shown by `via servers` once its catalog has been fetched, and by `via doctor` live', async () => {
    const { sb } = await setup(generation);
    expect(protocolColumn((await sb.via(['servers'])).stdout)).toBe('-');
    expect((await sb.via(['gh'])).code).toBe(0);
    expect(protocolColumn((await sb.via(['servers'])).stdout)).toBe(label);
    const doctor = await sb.via(['doctor']);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain(`gh: MCP ${label}\n`);
  });

  it('is called as before, whichever protocol it speaks', async () => {
    const { srv, sb } = await setup(generation);
    const r = await sb.via(['gh', 'issue:read', '--owner', 'acme', '--repo', 'api', '--issue-number', '3', '--method', 'get']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('number: 3\ntitle: Support OAuth DCR\nstate: open\n');
    expect(srv.state.calls).toHaveLength(1);
  });
});

describe('protocolVersion', () => {
  it('pins a version the server speaks: shown as pinned', async () => {
    const { sb } = await setup('legacy', '    protocolVersion: 2025-06-18\n');
    expect(protocolColumn((await sb.via(['servers'])).stdout)).toBe('2025-06-18 (pinned)');
    expect((await sb.via(['gh'])).code).toBe(0);
    expect(protocolColumn((await sb.via(['servers'])).stdout)).toBe('2025-06-18 stateless (pinned)');
    expect((await sb.via(['doctor'])).stdout).toContain('gh: MCP 2025-06-18 stateless (pinned)\n');
  });

  it('is an error, not a fallback, when the server does not support it', async () => {
    const { sb } = await setup('legacy', '    protocolVersion: 2026-07-28\n');
    const r = await sb.via(['gh']);
    expect(r.code).toBe(6);
    expect(r.stderr).toContain('error: cannot start gh: it does not support protocol version 2026-07-28; servers.gh.protocolVersion pins it');
    const doctor = await sb.via(['doctor']);
    expect(doctor.code).toBe(6);
    expect(doctor.stdout).toContain('it does not support protocol version 2026-07-28');
    expect(doctor.stdout).toContain('next: remove protocolVersion from servers.gh, or pin a version the server supports');
    const call = await sb.via(['gh', 'echo_text', '--message', 'x']);
    expect(call.code).toBe(6);
    expect(call.stderr).toBe('error: cannot start gh: it does not support protocol version 2026-07-28; servers.gh.protocolVersion pins it\nnext: remove protocolVersion from servers.gh, or pin a version the server supports\n');
  });

  it('names what a stateless server supports when the pin is older', async () => {
    const { sb } = await setup('modern', '    protocolVersion: 2025-11-25\n');
    const r = await sb.via(['gh', 'echo_text', '--message', 'x']);
    expect(r.code).toBe(6);
    expect(r.stderr).toContain('it does not support protocol version 2025-11-25 (it supports 2026-07-28)');
  });

  it('rejects a value that is not a protocol version, naming the ones that are', async () => {
    const { sb } = await setup('legacy', '    protocolVersion: "1999-01-01"\n');
    const r = await sb.via(['servers']);
    expect(r.stdout).toContain('servers.gh.protocolVersion: expected one of 2026-07-28, 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07');
    expect((await sb.via(['gh'])).code).toBe(2);
  });
});
