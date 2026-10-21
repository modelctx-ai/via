// via's own outbound requests follow HTTPS_PROXY / HTTP_PROXY / NO_PROXY (config.md, "代理", security.md):
// the MCP HTTP transport, OAuth, `via doctor`'s report. The origin servers are on loopback over http, so
// the variable that matters is HTTP_PROXY; the CONNECT path for https is in test/proxy.test.ts.
import { describe, expect, it } from 'vitest';
import { startOAuthServer } from '../fixtures/mcp/oauth-server.mjs';
import { startEmbeddingsServer } from '../helpers/embeddings-server';
import { startProxy } from '../helpers/proxy-server';
import { FAKE_TOKEN, ghConfig, makeSandbox, startFixtureServer, useCleanup } from './helpers';

async function setup(extra = '') {
  const srv = await startFixtureServer({ token: FAKE_TOKEN });
  useCleanup(() => srv.close());
  const proxy = await startProxy();
  useCleanup(() => proxy.close());
  const sb = makeSandbox();
  sb.userConfig(ghConfig(srv.url, extra));
  return { srv, proxy, sb };
}

describe('MCP over HTTP', () => {
  it('goes through HTTP_PROXY, and the server still answers', async () => {
    const { srv, proxy, sb } = await setup();
    const r = await sb.via(['gh', 'echo_text', '--message', 'hi'], { env: { HTTP_PROXY: proxy.url } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('echo: hi\n');
    expect(srv.state.calls).toEqual([{ name: 'echo_text', args: { message: 'hi' } }]);
    // The probe, the handshake, the listing and the call, all of them carried by the proxy, in absolute form.
    const lines = proxy.log.map((l) => l.line);
    expect(lines.filter((l) => l === `POST ${srv.url}`).length).toBeGreaterThanOrEqual(3);
    expect(lines.every((l) => l.endsWith(` ${srv.url}`))).toBe(true);
  });

  it('accepts the lower-case name', async () => {
    const { proxy, sb } = await setup();
    expect((await sb.via(['gh'], { env: { http_proxy: proxy.url } })).code).toBe(0);
    expect(proxy.log.length).toBeGreaterThan(0);
  });

  it('skips the proxy for hosts NO_PROXY lists', async () => {
    const { proxy, sb } = await setup();
    const r = await sb.via(['gh', 'echo_text', '--message', 'hi'], { env: { HTTP_PROXY: proxy.url, NO_PROXY: 'localhost,127.0.0.1' } });
    expect(r.code).toBe(0);
    expect(proxy.log).toEqual([]);
  });

  it('is direct when no proxy variable is set, even with NO_PROXY', async () => {
    const { proxy, sb } = await setup();
    expect((await sb.via(['gh'], { env: { NO_PROXY: 'example.com' } })).code).toBe(0);
    expect(proxy.log).toEqual([]);
  });

  it('is not used for an http server when only HTTPS_PROXY is set', async () => {
    const { proxy, sb } = await setup();
    expect((await sb.via(['gh'], { env: { HTTPS_PROXY: proxy.url } })).code).toBe(0);
    expect(proxy.log).toEqual([]);
  });

  it('reports an unreachable proxy as an upstream failure without printing its credentials', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'echo_text', '--message', 'hi'], { env: { HTTP_PROXY: 'http://alice:hunter2pass@127.0.0.1:1' } });
    expect(r.code).toBe(6);
    expect(r.stdout + r.stderr).not.toMatch(/alice|hunter2pass/);
  });

  it('refuses a proxy of a kind it cannot speak instead of connecting directly (exit 2)', async () => {
    const { srv, sb } = await setup();
    const r = await sb.via(['gh', 'echo_text', '--message', 'hi'], { env: { HTTP_PROXY: 'socks5://alice:hunter2pass@127.0.0.1:1080' } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('HTTP_PROXY: unsupported proxy scheme "socks5" (only http and https proxies are supported)');
    expect(r.stderr).toContain('next: fix the proxy variable, or unset it');
    expect(r.stdout + r.stderr).not.toMatch(/alice|hunter2pass/);
    expect(srv.state.calls).toEqual([]);
  });
});

describe('via doctor', () => {
  it('says no proxy is in effect, or which one, with the user name and password hidden', async () => {
    const { proxy, sb } = await setup();
    expect((await sb.via(['doctor'])).stdout).toContain('\nproxy     none\n');
    const url = new URL(proxy.url);
    url.username = 'alice';
    url.password = 'hunter2pass';
    const r = await sb.via(['doctor'], { env: { HTTPS_PROXY: url.href, HTTP_PROXY: proxy.url, no_proxy: 'localhost,127.0.0.1' } });
    expect(r.stdout).toContain(`\nproxy     https http://***@${url.host} (HTTPS_PROXY)\n          http ${proxy.url} (HTTP_PROXY)\n          no proxy for localhost, 127.0.0.1 (no_proxy)\n`);
    expect(r.stdout + r.stderr).not.toMatch(/alice|hunter2pass/);
  });
});

describe('OAuth', () => {
  it('logs in, and logs out, through the proxy', async () => {
    const srv = await startOAuthServer({});
    useCleanup(() => srv.close());
    const proxy = await startProxy();
    useCleanup(() => proxy.close());
    const sb = makeSandbox({});
    sb.userConfig(`sources: false\nservers:\n  linear:\n    url: ${srv.url}\n    auth: oauth\n`);
    const env = { HTTP_PROXY: proxy.url };
    const login = await sb.via(['auth', 'login', 'linear'], {
      env,
      openUrl: async (url) => {
        srv.browse(url).catch(() => undefined);
        return { opened: true };
      },
    });
    expect(login.code).toBe(0);
    const paths = proxy.log.map((l) => new URL(l.line.split(' ')[1]!).pathname);
    expect(paths).toEqual(expect.arrayContaining(['/mcp', '/register', '/token']));
    expect(paths.some((p) => p.startsWith('/.well-known/'))).toBe(true);
    // A call with the saved login also goes through it.
    const before = proxy.log.length;
    expect((await sb.via(['linear'], { env })).code).toBe(0);
    expect(proxy.log.length).toBeGreaterThan(before);
    const out = await sb.via(['auth', 'logout', 'linear'], { env });
    expect(out.code).toBe(0);
  });
});

describe('via find with search.semantic', () => {
  it('sends the embedding requests through the proxy', async () => {
    const srv = await startFixtureServer();
    useCleanup(() => srv.close());
    const emb = await startEmbeddingsServer({ concepts: { zorp: 'echo' } });
    useCleanup(() => emb.close());
    const proxy = await startProxy();
    useCleanup(() => proxy.close());
    const sb = makeSandbox({ GH_TOKEN: FAKE_TOKEN });
    sb.userConfig(`${ghConfig(srv.url)}search:\n  semantic:\n    url: ${emb.url}\n    model: fake-embed\n`);
    const r = await sb.via(['find', 'zorp'], { env: { HTTP_PROXY: proxy.url } });
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n')[0]).toContain('echo');
    expect(proxy.log.some((l) => l.line.startsWith(`POST ${emb.url}`))).toBe(true);
    expect(emb.requests.length).toBeGreaterThan(0);
  });
});
