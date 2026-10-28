// via's own outbound requests follow the proxy variables (docs/spec/config.md, "代理"): which variable wins,
// what NO_PROXY exempts, what `via doctor` shows, and that a request really goes through a proxy.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { bypassed, describeProxy, ProxyConfigError, proxyFetch, proxyFor, proxySettings } from '../src/proxy';
import { startProxy, type ProxyServer } from './helpers/proxy-server';

const settings = (env: Record<string, string>) => proxySettings(env)!;
const target = (url: string) => new URL(url);

describe('proxySettings', () => {
  it('is undefined when no proxy variable is set (NO_PROXY alone does nothing)', () => {
    expect(proxySettings({})).toBeUndefined();
    expect(proxySettings({ NO_PROXY: 'localhost', PATH: '/bin' })).toBeUndefined();
    expect(proxySettings({ HTTPS_PROXY: '  ', http_proxy: '' })).toBeUndefined();
  });

  it('reads the variables in either case, the upper-case spelling first', () => {
    expect(settings({ https_proxy: 'http://lower:1' }).https).toEqual({ url: 'http://lower:1', variable: 'https_proxy' });
    expect(settings({ HTTPS_PROXY: 'http://upper:1', https_proxy: 'http://lower:1' }).https).toEqual({ url: 'http://upper:1', variable: 'HTTPS_PROXY' });
    expect(settings({ Http_Proxy: 'http://mixed:1' }).http).toEqual({ url: 'http://mixed:1', variable: 'Http_Proxy' });
    expect(settings({ HTTP_PROXY: 'http://p:1', no_proxy: 'a.test' })).toMatchObject({ noProxy: 'a.test', noProxyVariable: 'no_proxy' });
  });
});

describe('proxyFor', () => {
  const both = settings({ HTTPS_PROXY: 'http://secure:3128', HTTP_PROXY: 'http://plain:3128' });

  it('uses HTTPS_PROXY for an https URL and HTTP_PROXY for an http URL', () => {
    expect(proxyFor(both, target('https://api.example.com/mcp'))?.proxy.host).toBe('secure:3128');
    expect(proxyFor(both, target('http://api.example.com/mcp'))?.proxy.host).toBe('plain:3128');
  });

  it('falls back to HTTP_PROXY for https, but never the other way round', () => {
    expect(proxyFor(settings({ HTTP_PROXY: 'http://plain:3128' }), target('https://a.test/'))?.proxy.host).toBe('plain:3128');
    expect(proxyFor(settings({ HTTPS_PROXY: 'http://secure:3128' }), target('http://127.0.0.1:9/'))).toBeUndefined();
  });

  it('takes a proxy written as host:port for an http proxy', () => {
    expect(proxyFor(settings({ HTTPS_PROXY: 'proxy.corp:8080' }), target('https://a.test/'))?.proxy.href).toBe('http://proxy.corp:8080/');
  });

  it('refuses a proxy it cannot use instead of going direct', () => {
    expect(() => proxyFor(settings({ HTTPS_PROXY: 'socks5://proxy:1080' }), target('https://a.test/'))).toThrow(ProxyConfigError);
    expect(() => proxyFor(settings({ HTTPS_PROXY: 'socks5://u:secret-pass@proxy:1080' }), target('https://a.test/'))).toThrow('HTTPS_PROXY: unsupported proxy scheme "socks5"');
    try {
      proxyFor(settings({ HTTPS_PROXY: 'socks5://u:secret-pass@proxy:1080' }), target('https://a.test/'));
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-pass');
    }
    expect(() => proxyFor(settings({ HTTPS_PROXY: 'http://[' }), target('https://a.test/'))).toThrow('HTTPS_PROXY is not a proxy URL');
  });
});

describe('NO_PROXY', () => {
  const no = (list: string, url: string): boolean => bypassed(settings({ HTTPS_PROXY: 'http://p:1', NO_PROXY: list }), target(url));

  it.each([
    ['*', 'https://anything.example/', true],
    ['example.com', 'https://example.com/', true],
    ['example.com', 'https://api.example.com/', true],
    ['example.com', 'https://notexample.com/', false],
    ['.example.com', 'https://api.example.com/', true],
    ['.example.com', 'https://example.com/', false],
    ['*.example.com', 'https://api.example.com/', true],
    ['*.example.com', 'https://example.com/', false],
    ['EXAMPLE.com', 'https://Example.COM/', true],
    ['example.com:8443', 'https://example.com:8443/', true],
    ['example.com:8443', 'https://example.com/', false],
    ['example.com:443', 'https://example.com/', true],
    ['127.0.0.1', 'http://127.0.0.1:4000/', true],
    ['127.0.0.1:4000', 'http://127.0.0.1:4001/', false],
    ['[::1]', 'http://[::1]:4000/', true],
    ['::1', 'http://[::1]:4000/', true],
    ['localhost, .corp ,internal.test', 'https://db.corp/', true],
    ['localhost;other', 'https://other/', false],
    ['', 'https://example.com/', false],
  ] as const)('%j exempts %s: %s', (list, url, expected) => {
    expect(no(list, url)).toBe(expected);
  });

  it('is applied before a proxy is chosen', () => {
    expect(proxyFor(settings({ HTTPS_PROXY: 'http://p:1', NO_PROXY: 'internal.test' }), target('https://api.internal.test/'))).toBeUndefined();
  });
});

describe('describeProxy', () => {
  it('shows nothing for no proxy', () => {
    expect(describeProxy(undefined)).toEqual([]);
  });

  it('hides the user name and password and names the variables', () => {
    expect(describeProxy(settings({ HTTPS_PROXY: 'http://alice:s3cret@proxy.corp:3128', HTTP_PROXY: 'http://other.corp:80', no_proxy: 'localhost,.corp' }))).toEqual([
      'https http://***@proxy.corp:3128 (HTTPS_PROXY)',
      'http http://other.corp (HTTP_PROXY)',
      'no proxy for localhost, .corp (no_proxy)',
    ]);
    const text = describeProxy(settings({ https_proxy: 'http://alice:s3cret@proxy.corp:3128' })).join('\n');
    expect(text).not.toMatch(/alice|s3cret/);
    expect(text).toContain('http requests go direct');
  });

  it('reports a proxy it cannot use without printing its value', () => {
    const lines = describeProxy(settings({ HTTPS_PROXY: 'socks5://u:pw12345@proxy:1080' }));
    expect(lines.join('\n')).toContain('unsupported proxy scheme "socks5"');
    expect(lines.join('\n')).not.toMatch(/pw12345|u:/);
  });
});

describe('proxyFetch', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function origin(): Promise<{ url: string; hits: string[] }> {
    const hits: string[] = [];
    const server: Server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url} ${String(req.headers.host)}`);
      res.writeHead(200, { 'content-type': 'text/plain' }).end('from origin');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hello`, hits };
  }

  async function proxy(): Promise<ProxyServer> {
    const p = await startProxy();
    closers.push(p.close);
    return p;
  }

  it('is undefined without a proxy variable: the caller keeps the plain fetch', () => {
    expect(proxyFetch({ PATH: '/bin', NO_PROXY: '*' })).toBeUndefined();
  });

  it('sends an http request through HTTP_PROXY', async () => {
    const [o, p] = [await origin(), await proxy()];
    const send = proxyFetch({ HTTP_PROXY: p.url })!;
    const response = await send(o.url);
    expect(await response.text()).toBe('from origin');
    expect(p.log.map((l) => l.line)).toEqual([`GET ${o.url}`]);
    expect(o.hits).toHaveLength(1);
  });

  it('gives the proxy its credentials and tells the redactor about them', async () => {
    const [o, p] = [await origin(), await proxy()];
    const tracked: string[] = [];
    const url = new URL(p.url);
    url.username = 'alice';
    url.password = 'pa:ss';
    const send = proxyFetch({ http_proxy: url.href }, { track: (s) => tracked.push(s) })!;
    await (await send(o.url)).text();
    expect(p.log[0]?.authorization).toBe(`Basic ${Buffer.from('alice:pa:ss').toString('base64')}`);
    expect(tracked).toEqual(['alice', 'pa:ss']);
  });

  it('does not use the proxy for a host NO_PROXY lists', async () => {
    const [o, p] = [await origin(), await proxy()];
    const send = proxyFetch({ HTTP_PROXY: p.url, NO_PROXY: '127.0.0.1' })!;
    expect(await (await send(o.url)).text()).toBe('from origin');
    expect(p.log).toEqual([]);
    expect(o.hits).toHaveLength(1);
  });

  it('does not send an http request through a lone HTTPS_PROXY', async () => {
    const [o, p] = [await origin(), await proxy()];
    const send = proxyFetch({ HTTPS_PROXY: p.url })!;
    expect(await (await send(o.url)).text()).toBe('from origin');
    expect(p.log).toEqual([]);
  });

  it('tunnels an https request with CONNECT', async () => {
    const [o, p] = [await origin(), await proxy()];
    // The origin speaks plain http, so the TLS handshake inside the tunnel fails; that the proxy was asked
    // to CONNECT to it is what is checked here (the cause is a TLS error, not a refused proxy).
    const send = proxyFetch({ HTTPS_PROXY: p.url })!;
    const port = new URL(o.url).port;
    await send(`https://127.0.0.1:${port}/hello`).catch(() => undefined);
    expect(p.log.map((l) => l.line)).toEqual([`CONNECT 127.0.0.1:${port}`]);
  });

  it('throws the configuration error for an unusable proxy, with no request sent', async () => {
    const o = await origin();
    const send = proxyFetch({ HTTP_PROXY: 'socks5://127.0.0.1:1' })!;
    await expect(send(o.url)).rejects.toBeInstanceOf(ProxyConfigError);
    expect(o.hits).toEqual([]);
  });

  it('keeps the error code of an unreachable proxy and scrubs credentials from its message', async () => {
    const send = proxyFetch({ HTTP_PROXY: 'http://alice:topsecret@127.0.0.1:1' })!;
    const error = (await send('http://example.invalid/').catch((e: unknown) => e)) as Error & { cause?: Error & { code?: string } };
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify({ message: error.message, cause: error.cause?.message })).not.toContain('topsecret');
    expect(error.cause?.code).toMatch(/^E|^UND_ERR/);
  });

  it('keeps the type and every cause of a refused tunnel, as a direct failure would have them', async () => {
    const p = await startProxy({ refuseTunnels: 403 });
    closers.push(p.close);
    const url = new URL(p.url);
    const send = proxyFetch({ HTTPS_PROXY: `http://alice:topsecret@${url.host}` })!;
    const error = (await send('https://mcp.example.invalid/mcp').catch((e: unknown) => e)) as Error;
    // `fetch failed` is a TypeError; undici puts what the proxy said two causes down.
    expect(error).toBeInstanceOf(TypeError);
    const chain: Array<{ message: string; code?: unknown }> = [];
    for (let cur: unknown = error; cur instanceof Error; cur = cur.cause) chain.push({ message: cur.message, code: (cur as { code?: unknown }).code });
    expect(chain.some((c) => c.message.startsWith('Proxy response (403)') && c.code === 'UND_ERR_ABORTED')).toBe(true);
    expect(JSON.stringify(chain)).not.toContain('topsecret');
    expect(p.log.map((l) => l.line)).toEqual(['CONNECT mcp.example.invalid:443']);
  });
});
