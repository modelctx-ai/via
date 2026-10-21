// `via skills` through a real daemon over a stdio server of the stateless protocol: the manifest check runs in the
// daemon's session, before the daemon redacts what it returns (ADR 0020; daemon.md).
import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN } from '../cli/helpers';
import { daemonSandbox } from '../helpers/daemon';
import { fixtureScript } from '../helpers/generation';

const SERVER = fixtureScript('cli-stdio-server', 'modern');
const config = `sources: false\nservers:\n  fs:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(SERVER)}]\n    env: { CLI_FIXTURE_FEATURES: "skills", FIXTURE_SECRET: "env:GH_TOKEN" }\n`;

describe('via skills through the daemon', () => {
  it('lists, reads, refuses a mismatch, and redacts only after the check', async () => {
    const d = await daemonSandbox(config, { GH_TOKEN: FAKE_TOKEN });
    const list = await d.via(['skills', 'fs']);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('refunds');

    const read = await d.via(['skills', 'fs', 'refunds', 'references/FORMS.md']);
    expect(read.stdout).toBe('Refund form fields:\n- order id\n- amount\n');

    // The text of this skill contains the credential: it matches its digest because the check saw the original bytes.
    const echo = await d.via(['skills', 'fs', 'echo']);
    expect(echo.code).toBe(0);
    expect(echo.stdout).toContain('authorization: ***');
    expect(echo.combined).not.toContain(FAKE_TOKEN);

    const tampered = await d.via(['skills', 'fs', 'tampered']);
    expect(tampered.code).toBe(6);
    expect(tampered.stdout).toBe('');
    expect(tampered.stderr).toContain('refused skill://tampered/SKILL.md');

    const inProcess = await d.via(['skills', 'fs', 'refunds'], { env: { VIA_NO_DAEMON: '1' } });
    expect(inProcess.stdout).toBe((await d.via(['skills', 'fs', 'refunds'])).stdout);
  });

  it('says a stdio server of the old protocol has no skills', async () => {
    const d = await daemonSandbox(config.replace(SERVER, fixtureScript('cli-stdio-server', 'legacy')), { GH_TOKEN: FAKE_TOKEN });
    const r = await d.via(['skills', 'fs']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('fs does not offer MCP skills: it speaks MCP');
  });
});
