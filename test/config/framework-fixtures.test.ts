// One sample tree per framework added or reshaped in the 0.2 verification pass
// (test/fixtures/config/frameworks/<id>/{home,project}); the shared sample tree stays as it was.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, type LoadedConfig } from '../../src/config';
import { CONFIG_FIXTURES, makeTree, server, tempDir } from '../helpers/config';

function load(id: string, sources: string[] = [id]): Promise<LoadedConfig> {
  const root = join(CONFIG_FIXTURES, 'frameworks', id);
  return loadConfig({ home: join(root, 'home'), cwd: join(root, 'project'), projectRoot: join(root, 'project'), env: {}, platform: 'linux', dataDir: tempDir(), cliOverrides: { sources } });
}

const codes = (config: LoadedConfig) => config.diagnostics.map((d) => `${d.level}:${d.code}:${d.server ?? ''}`).sort();

describe('gemini-cli', () => {
  it('reads settings.json (JSONC) with $NAME variables, httpUrl and url', async () => {
    const config = await load('gemini-cli');
    expect(config.servers.map((s) => [s.name, s.origin.framework, s.origin.scope]).sort()).toEqual([
      ['gem-http', 'gemini-cli', 'framework-user'],
      ['gem-local', 'gemini-cli', 'framework-user'],
      ['gem-proj', 'gemini-cli', 'framework-project'],
      ['gem-sse', 'gemini-cli', 'framework-user'],
    ]);
    expect(server(config, 'gem-local').transport).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['./server.js'],
      cwd: './tools',
      env: { API_KEY: 'env:GEM_TOKEN', REGION: 'eu', OTHER: 'env:GEM_OTHER' },
    });
    expect(server(config, 'gem-http').transport).toEqual({
      type: 'http',
      url: 'https://gem-http.example.invalid/mcp',
      headers: { Authorization: 'Bearer $GEM_TOKEN', 'X-Key': 'env:GEM_KEY' },
    });
  });

  it('warns about a variable inside a longer value, and about the legacy SSE transport', async () => {
    const config = await load('gemini-cli');
    expect(codes(config)).toEqual(['warning:legacy-transport:gem-sse', 'warning:unexpanded-variable:gem-http']);
  });
});

describe('antigravity', () => {
  it('reads serverUrl servers and ignores disabled and disabledTools', async () => {
    const config = await load('antigravity');
    // Only a header value that merely contains a variable is reported.
    expect(codes(config)).toEqual(['warning:unexpanded-variable:agy-remote']);
    expect(config.servers.map((s) => s.name).sort()).toEqual(['agy-local', 'agy-proj', 'agy-remote']);
    expect(server(config, 'agy-remote').transport).toEqual({ type: 'http', url: 'https://agy.example.invalid/mcp', headers: { Authorization: 'Bearer ${AGY_TOKEN}' } });
    expect(server(config, 'agy-local')).toMatchObject({ disabled: false, transport: { type: 'stdio', command: 'npx', env: { AGY_KEY: 'env:AGY_KEY' } } });
  });
});

describe('copilot-cli', () => {
  it('reads type local/http/sse from ~/.copilot/mcp-config.json and .github/mcp.json', async () => {
    const config = await load('copilot-cli');
    expect(config.servers.map((s) => s.name).sort()).toEqual(['cop-http', 'cop-local', 'cop-proj', 'cop-sse']);
    expect(server(config, 'cop-http').transport).toEqual({ type: 'http', url: 'https://cop-http.example.invalid/mcp', headers: { 'X-Team': 'platform' } });
    expect(server(config, 'cop-local').transport).toMatchObject({ type: 'stdio', command: 'npx', args: ['-y', 'cop-server'], env: { COP_KEY: 'env:COP_KEY' } });
    expect(server(config, 'cop-proj').transport).toMatchObject({ type: 'stdio', command: 'node' });
    expect(codes(config)).toEqual(['warning:legacy-transport:cop-sse']);
  });
});

describe('amp', () => {
  it('reads the dotted amp.mcpServers key from JSONC; the workspace overrides the user file', async () => {
    const config = await load('amp');
    // settings.jsonc does not exist next to settings.json, which is not worth a warning.
    expect(codes(config)).toEqual(['warning:unexpanded-variable:amp-remote']);
    expect(config.servers.map((s) => s.name).sort()).toEqual(['amp-local', 'amp-remote', 'amp-shared']);
    expect(server(config, 'amp-shared')).toMatchObject({ transport: { command: 'project-shared' }, origin: { scope: 'framework-project' } });
    expect(server(config, 'amp-shared')).not.toHaveProperty('conflicts');
    expect(server(config, 'amp-remote').transport).toMatchObject({ type: 'http', headers: { Authorization: 'Bearer ${AMP_TOKEN}' } });
  });
});

describe('devin', () => {
  it('layers .devin/mcp_config.local.json over .devin/mcp_config.json over the user file', async () => {
    const config = await load('devin');
    expect(server(config, 'dev-layered')).toMatchObject({ transport: { command: 'dev-local' }, origin: { scope: 'framework-project' } });
    expect(server(config, 'dev-layered').origin.path?.endsWith(join('.devin', 'mcp_config.local.json'))).toBe(true);
    expect(config.servers.map((s) => s.name).sort()).toEqual(['dev-layered', 'dev-off', 'dev-proj', 'dev-remote']);
  });

  it('accepts transport and ignores disabled and oauth fields', async () => {
    const config = await load('devin');
    expect(server(config, 'dev-remote').transport).toEqual({ type: 'http', url: 'https://dev.example.invalid/sse', headers: { 'X-Team': 'platform' } });
    expect(server(config, 'dev-off').disabled).toBe(false);
    expect(codes(config)).toEqual(['warning:legacy-transport:dev-remote']);
  });

  it('uses %APPDATA% on Windows', async () => {
    const root = join(CONFIG_FIXTURES, 'frameworks', 'devin');
    const config = await loadConfig({
      home: join(root, 'home'),
      cwd: join(root, 'project'),
      projectRoot: join(root, 'project'),
      env: { APPDATA: join(root, 'nowhere') },
      platform: 'win32',
      dataDir: tempDir(),
      cliOverrides: { sources: ['devin'] },
    });
    expect(config.servers.map((s) => s.name).sort()).toEqual(['dev-layered', 'dev-proj']);
  });
});

describe('codex env_vars', () => {
  it('takes names and { name, source = local }; remote-sourced and malformed items are warnings', async () => {
    const config = await load('codex');
    expect(server(config, 'cdx-env').transport).toMatchObject({
      env: { PLAIN_VAR: 'env:PLAIN_VAR', LOCAL_VAR: 'env:LOCAL_VAR', BARE_OBJECT: 'env:BARE_OBJECT' },
    });
    expect(server(config, 'cdx-env').transport).not.toHaveProperty('env.REMOTE_VAR');
    expect(config.diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining('servers.cdx-env: env_vars[3]: source "remote" is not available to via'),
      expect.stringContaining('servers.cdx-bad: env_vars[0]: expected a name or { name, source }'),
      expect.stringContaining('servers.cdx-bad: env_vars[1]: expected a name or { name, source }'),
    ]);
  });
});

describe('bare $NAME values', () => {
  it('stay literal for a framework that does not expand them', async () => {
    const tree = makeTree({ 'home/.cursor/mcp.json': '{"mcpServers":{"a":{"command":"a","env":{"K":"$LITERAL","J":"${BRACED}"}}}}' });
    const config = await tree.load({ cliOverrides: { sources: ['cursor'] } });
    expect(server(config, 'a').transport).toMatchObject({ env: { K: '$LITERAL', J: 'env:BRACED' } });
    expect(config.diagnostics).toEqual([]);
  });
});
