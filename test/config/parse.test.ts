import { describe, expect, it } from 'vitest';
import { normalizeFrameworkEntry } from '../../src/config/normalize';
import { parseConfigText, ParseFailure, resolvePointer } from '../../src/config/parse';

const LEAKY = 'fake-secret-in-a-broken-file';

describe('parseConfigText', () => {
  it('parses strict JSON and rejects comments in it', async () => {
    expect(await parseConfigText('{"a": [1, 2]}', 'json')).toEqual({ a: [1, 2] });
    expect(await parseConfigText('﻿{"a": 1}', 'json')).toEqual({ a: 1 });
    await expect(parseConfigText('{ // c\n "a": 1 }', 'json')).rejects.toBeInstanceOf(ParseFailure);
    await expect(parseConfigText('{"a": 1,}', 'json')).rejects.toBeInstanceOf(ParseFailure);
  });

  it('parses JSONC with comments and trailing commas', async () => {
    expect(await parseConfigText('{ // c\n /* d */ "a": [1,], }', 'jsonc')).toEqual({ a: [1] });
  });

  it('parses TOML and YAML', async () => {
    expect(await parseConfigText('[mcp_servers.x]\ncommand = "npx"\n', 'toml')).toEqual({ mcp_servers: { x: { command: 'npx' } } });
    expect(await parseConfigText('servers:\n  x: { command: npx }\n', 'yaml')).toEqual({ servers: { x: { command: 'npx' } } });
    expect(await parseConfigText('', 'yaml')).toBeNull();
  });

  it.each([
    ['json', `{\n  "token": "${LEAKY}"\n  "x": 1\n}`, 'line 3'],
    ['jsonc', `{ "token": "${LEAKY}" "x": 1 }`, 'line 1'],
    ['toml', `token = "${LEAKY}"\nx = = 1\n`, 'line 2'],
    ['yaml', `token: ${LEAKY}\nx: [unclosed\n`, 'line'],
  ] as const)('reports where %s is broken without quoting the file', async (format, text, where) => {
    const error = await parseConfigText(text, format).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(ParseFailure);
    expect(error?.message).toContain(where);
    expect(error?.message).not.toContain(LEAKY);
  });

  it('rejects duplicate YAML keys instead of silently taking one', async () => {
    await expect(parseConfigText('a: 1\na: 2\n', 'yaml')).rejects.toBeInstanceOf(ParseFailure);
  });
});

describe('resolvePointer', () => {
  const doc = { mcpServers: { 'a/b': { x: 1 }, 'c~d': 2 }, list: [{ k: 'v' }], empty: null };
  it('walks objects and arrays and unescapes ~0 and ~1', () => {
    expect(resolvePointer(doc, '/mcpServers')).toEqual({ found: true, value: doc.mcpServers });
    expect(resolvePointer(doc, '/mcpServers/a~1b/x')).toEqual({ found: true, value: 1 });
    expect(resolvePointer(doc, '/mcpServers/c~0d')).toEqual({ found: true, value: 2 });
    expect(resolvePointer(doc, '/list/0/k')).toEqual({ found: true, value: 'v' });
    expect(resolvePointer(doc, '')).toEqual({ found: true, value: doc });
  });
  it('reports a missing target instead of throwing', () => {
    for (const pointer of ['/nope', '/mcpServers/zzz/x', '/empty/x', '/list/5', 'mcpServers', '/__proto__/x', '/toString']) {
      expect(resolvePointer(doc, pointer)).toEqual({ found: false });
    }
  });
});

describe('normalizeFrameworkEntry', () => {
  const norm = (entry: unknown) => normalizeFrameworkEntry('x', entry, '/f.json');

  it.each([
    ['type stdio', { type: 'stdio', command: 'npx' }],
    ['type local (OpenCode-style)', { type: 'local', command: 'npx' }],
    ['no type, command only', { command: 'npx' }],
    ['transport spelling', { transport: 'stdio', command: 'npx' }],
  ])('stdio: %s', (_n, entry) => {
    expect(norm(entry).def).toEqual({ command: 'npx', args: [], env: {} });
  });

  it.each([
    ['type http', { type: 'http', url: 'https://h.invalid/mcp' }],
    ['type streamable-http', { type: 'streamable-http', url: 'https://h.invalid/mcp' }],
    ['transport streamableHttp', { transport: 'streamableHttp', url: 'https://h.invalid/mcp' }],
    ['type remote', { type: 'remote', url: 'https://h.invalid/mcp' }],
    ['url only', { url: 'https://h.invalid/mcp' }],
    ['serverUrl (Windsurf)', { serverUrl: 'https://h.invalid/mcp' }],
    ['httpUrl', { httpUrl: 'https://h.invalid/mcp' }],
  ])('http: %s', (_n, entry) => {
    expect(norm(entry).def).toEqual({ url: 'https://h.invalid/mcp', headers: {} });
    expect(norm(entry).diagnostics).toEqual([]);
  });

  it('accepts legacy sse as http, with a warning', () => {
    const r = norm({ type: 'sse', url: 'https://h.invalid/sse' });
    expect(r.def?.url).toBe('https://h.invalid/sse');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['legacy-transport']);
  });

  it('copies command, args, env and cwd; numbers and booleans become text', () => {
    const r = norm({ command: 'node', args: ['a', 1], env: { PORT: 8080, DEBUG: true, K: 'v' }, cwd: '/work' });
    expect(r.def).toEqual({ command: 'node', args: ['a', '1'], env: { PORT: '8080', DEBUG: 'true', K: 'v' }, cwd: '/work' });
  });

  it('keeps plaintext values as they are (doctor warns about them)', () => {
    const r = norm({ url: 'https://h.invalid/mcp', headers: { 'X-Key': 'fake-plain-value' } });
    expect(r.def?.headers).toEqual({ 'X-Key': 'fake-plain-value' });
  });

  it('turns whole-value variable references into env: references', () => {
    const r = norm({ command: 'x', env: { A: '${A_KEY}', B: '${env:B_KEY}', C: 'pre-${C}', D: '$D' } });
    expect(r.def?.env).toEqual({ A: 'env:A_KEY', B: 'env:B_KEY', C: 'pre-${C}', D: '$D' });
    expect(r.diagnostics.map((d) => [d.code, d.level])).toEqual([['unexpanded-variable', 'warning']]);
    expect(r.diagnostics[0]?.message).toContain('env.C');
    expect(r.diagnostics[0]?.message).not.toContain('env.A');
  });

  it('understands the Codex spellings', () => {
    expect(norm({ command: 'x', env: { A: '1' }, env_vars: ['B', 'A'] }).def?.env).toEqual({ A: '1', B: 'env:B' });
    const http = norm({ url: 'https://h.invalid/mcp', http_headers: { 'X-Team': 't' }, env_http_headers: { 'X-Key': 'SEARCH_KEY' }, bearer_token_env_var: 'LINEAR_API_KEY' });
    expect(http.def).toEqual({
      url: 'https://h.invalid/mcp',
      headers: { 'X-Team': 't', 'X-Key': 'env:SEARCH_KEY' },
      auth: { type: 'bearer', bearer: 'env:LINEAR_API_KEY' },
    });
  });

  it('ignores the framework-side disabled switches', () => {
    expect(norm({ command: 'x', disabled: true, enabled: false }).def?.command).toBe('x');
  });

  it('never runs or inherits helper commands', () => {
    expect(norm({ url: 'https://h.invalid/mcp', headersHelper: '/bin/get-token' }).def).toEqual({ url: 'https://h.invalid/mcp', headers: {} });
  });

  it.each([
    ['not a table', 'npx', 'expected a table'],
    ['array', ['npx'], 'expected a table'],
    ['neither', { args: ['x'] }, 'neither command nor url'],
    ['both without type', { command: 'x', url: 'https://h.invalid' }, 'both command and url'],
    ['unknown transport', { type: 'websocket', url: 'wss://h.invalid' }, 'unsupported transport "websocket"'],
    ['stdio without command', { type: 'stdio' }, 'stdio server without command'],
    ['http without url', { type: 'http' }, 'http server without url'],
  ])('rejects %s', (_n, entry, message) => {
    const r = norm(entry);
    expect(r.def).toBeUndefined();
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ level: 'error', code: 'invalid-server', file: '/f.json', server: 'x' });
    expect(r.diagnostics[0]?.message).toContain(message);
  });

  it('keeps going past a bad field and reports it', () => {
    const r = norm({ command: 'x', args: 'not-a-list', env: { OK: 'v', BAD: { nested: true } } });
    expect(r.def).toEqual({ command: 'x', args: [], env: { OK: 'v' } });
    expect(r.diagnostics.map((d) => d.message)).toEqual(['servers.x: args: expected a list of strings', 'servers.x: env.BAD: expected a string']);
  });

  it('survives a __proto__ key', () => {
    const entry = JSON.parse('{"command":"x","env":{"__proto__":"y","A":"b"}}') as unknown;
    const r = norm(entry);
    expect(r.def?.env).toEqual({ A: 'b' });
    expect(({} as Record<string, unknown>).A).toBeUndefined();
  });
});
