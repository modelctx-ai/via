// HTTP proxy settings for via's own outbound requests (docs/spec/config.md, "代理"): the MCP HTTP
// transport, OAuth (login, refresh, revoke) and the embedding endpoint of `find`. stdio children get the
// same variables through their environment (`client/env.ts`); this is for what via requests itself.
//
// Node's `fetch` ignores `HTTPS_PROXY`, so a request that has to go through a proxy is sent with an undici
// `ProxyAgent` as its dispatcher. undici is loaded only then: with no proxy variable set (almost always)
// nothing here costs anything but a scan of the environment, and it happens when a request is about to be
// made, never at CLI start. Under Bun, `fetch` takes the proxy as an option and undici is not involved.
//
// The rules (the same for every request, no per-server exceptions):
//  - variable names are case-insensitive; where both spellings of a name are set the upper-case one wins;
//  - a request to an https URL uses `HTTPS_PROXY`, else `HTTP_PROXY`; a request to an http URL uses
//    `HTTP_PROXY` only (so a loopback server over http is not sent to a proxy that can only reach the outside
//    when just `HTTPS_PROXY` is set);
//  - `NO_PROXY` is a comma separated list: `*` (everything), `example.com` (that host and its subdomains),
//    `.example.com` and `*.example.com` (subdomains), `host:port`, an IP literal; nothing is excluded unless
//    listed (not even `localhost`); CIDR ranges are not understood;
//  - only http and https proxies are supported; a proxy URL of another scheme (or one that is not a URL)
//    is an error for the requests it would have served, never a silent direct connection.
import type { FetchLike } from '@modelcontextprotocol/client';

type Env = Readonly<Record<string, string | undefined>>;

export interface ProxyEntry {
  /** The URL as set, userinfo included: handed to the proxy agent, never printed (use `describeProxy`). */
  url: string;
  /** The variable it came from, as spelled in the environment (`HTTPS_PROXY`, `http_proxy`, …). */
  variable: string;
}

export interface ProxySettings {
  https?: ProxyEntry;
  http?: ProxyEntry;
  /** The `NO_PROXY` list as set; `noProxyVariable` names the variable. */
  noProxy?: string;
  noProxyVariable?: string;
}

/** A proxy variable is set but cannot be used. Its message never contains the proxy URL's userinfo. */
export class ProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyConfigError';
  }
}

/** The value of `name` in `env`, any case; the upper-case spelling first. */
function lookup(env: Env, name: string): { value: string; variable: string } | undefined {
  const wanted = [name.toUpperCase(), name.toLowerCase()];
  for (const variable of wanted) {
    const value = env[variable];
    if (value !== undefined && value.trim() !== '') return { value: value.trim(), variable };
  }
  // Windows environments have their own spelling rules (`Https_Proxy`).
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === name.toLowerCase() && !wanted.includes(key) && value !== undefined && value.trim() !== '') return { value: value.trim(), variable: key };
  }
  return undefined;
}

/** The proxy variables of `env`; undefined when none is set (the common case: no proxy). */
export function proxySettings(env: Env): ProxySettings | undefined {
  const https = lookup(env, 'HTTPS_PROXY');
  const http = lookup(env, 'HTTP_PROXY');
  if (!https && !http) return undefined;
  const no = lookup(env, 'NO_PROXY');
  return {
    ...(https ? { https: { url: https.value, variable: https.variable } } : {}),
    ...(http ? { http: { url: http.value, variable: http.variable } } : {}),
    ...(no ? { noProxy: no.value, noProxyVariable: no.variable } : {}),
  };
}

/** A proxy URL as people write it: `host:port` without a scheme means http. */
function parseProxyUrl(entry: ProxyEntry): URL {
  const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(entry.url) ? entry.url : `http://${entry.url}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ProxyConfigError(`${entry.variable} is not a proxy URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProxyConfigError(`${entry.variable}: unsupported proxy scheme "${url.protocol.slice(0, -1)}" (only http and https proxies are supported)`);
  }
  return url;
}

/** Whether `host` (lower case, no brackets) with `port` is covered by one `NO_PROXY` entry. */
function matches(entry: string, host: string, port: string): boolean {
  let rule = entry.trim().toLowerCase();
  if (rule === '') return false;
  if (rule === '*') return true;
  let rulePort = '';
  const portMatch = /^(.*?):(\d+)$/.exec(rule);
  // `[::1]:8080` and `host:8080` carry a port; a bare IPv6 literal has colons but no port.
  if (portMatch && !(rule.includes(':') && portMatch[1]!.includes(':') && !portMatch[1]!.startsWith('['))) {
    rule = portMatch[1]!;
    rulePort = portMatch[2]!;
  }
  if (rulePort !== '' && rulePort !== port) return false;
  rule = rule.replace(/^\[|\]$/g, '');
  const subdomainsOnly = rule.startsWith('.') || rule.startsWith('*.');
  rule = rule.replace(/^\*?\./, '');
  if (rule === '') return false;
  if (host === rule) return !subdomainsOnly;
  return host.endsWith(`.${rule}`);
}

/** Whether `NO_PROXY` exempts a request to `url`. */
export function bypassed(settings: ProxySettings, url: URL): boolean {
  if (!settings.noProxy) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return settings.noProxy.split(/[\s,]+/).some((entry) => matches(entry, host, port));
}

/** The proxy a request to `url` goes through; undefined for a direct connection. Throws `ProxyConfigError` for an unusable proxy. */
export function proxyFor(settings: ProxySettings, url: URL): { entry: ProxyEntry; proxy: URL } | undefined {
  const entry = url.protocol === 'https:' ? (settings.https ?? settings.http) : url.protocol === 'http:' ? settings.http : undefined;
  if (!entry || bypassed(settings, url)) return undefined;
  return { entry, proxy: parseProxyUrl(entry) };
}

/** `http://proxy.corp:3128`, with a username or password shown as `***@`. Never the credentials themselves. */
function hideUserinfo(entry: ProxyEntry): string {
  try {
    const url = parseProxyUrl(entry);
    const hidden = url.username !== '' || url.password !== '';
    return `${url.protocol}//${hidden ? '***@' : ''}${url.host}${url.pathname !== '/' ? url.pathname : ''}`;
  } catch {
    // Not a URL we understand: say which variable and nothing of its value.
    return '(invalid)';
  }
}

/** The effective proxy as `via doctor` shows it: one line per proxy, then the exemptions. Empty when no proxy is set. */
export function describeProxy(settings: ProxySettings | undefined): string[] {
  if (!settings) return [];
  const lines: string[] = [];
  const add = (label: string, entry: ProxyEntry | undefined): void => {
    if (!entry) return;
    let note = '';
    try {
      parseProxyUrl(entry);
    } catch (error) {
      note = ` — ${(error as Error).message}`;
    }
    lines.push(`${label} ${hideUserinfo(entry)} (${entry.variable})${note}`);
  };
  add('https', settings.https);
  add('http', settings.http);
  if (settings.https && !settings.http) lines[lines.length - 1] += '; http requests go direct';
  if (settings.noProxy) lines.push(`no proxy for ${settings.noProxy.split(/[\s,]+/).filter(Boolean).join(', ')} (${settings.noProxyVariable})`);
  return lines;
}

/** Replace `user:pass@` in URLs and every secret in `secrets` in a message from the network layer. */
function scrub(text: string, secrets: readonly string[]): string {
  let out = text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1***@');
  for (const secret of secrets) if (secret !== '') out = out.split(secret).join('***');
  return out;
}

const agents = new Map<string, Promise<unknown>>();

export interface ProxyFetchOptions {
  /** Told the user name and password of a proxy URL, so output redaction knows them. */
  track?: (secret: string) => void;
}

/**
 * A `fetch` that goes through the proxy `env` asks for, or undefined when no proxy variable is set (use the
 * plain `fetch`). The proxy is chosen per request (scheme of the URL, `NO_PROXY`); a request that no proxy
 * serves is sent directly. `base` is what finally sends (default: the global `fetch`).
 */
export function proxyFetch(env: Env, options: ProxyFetchOptions = {}, base: FetchLike = (url, init) => fetch(url, init)): FetchLike | undefined {
  const settings = proxySettings(env);
  if (!settings) return undefined;
  for (const entry of [settings.https, settings.http]) {
    if (!entry) continue;
    try {
      const url = parseProxyUrl(entry);
      if (url.username !== '') options.track?.(decodeURIComponent(url.username));
      if (url.password !== '') options.track?.(decodeURIComponent(url.password));
    } catch {
      // reported when a request would use it
    }
  }
  return async (input, init) => {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : (input as Request).url);
    const via = proxyFor(settings, target);
    if (!via) return base(input, init);
    const secrets = [decodeURIComponent(via.proxy.username), decodeURIComponent(via.proxy.password)].filter((s) => s !== '');
    try {
      if (process.versions.bun) return await base(input, { ...init, proxy: via.proxy.href } as RequestInit);
      const key = via.proxy.href;
      let agent = agents.get(key);
      if (!agent) {
        // `proxyTunnel: false`: an http URL is forwarded in absolute form (what proxies expect); only https is tunnelled with CONNECT.
        agent = import('undici').then(
          (mod) => {
            // Bundled, undici is a CommonJS module whose chunk has only a default export; from source it has named ones too.
            const ProxyAgent = mod.ProxyAgent ?? mod.default.ProxyAgent;
            return new ProxyAgent({ uri: via.proxy.href, proxyTunnel: false });
          },
          () => {
            agents.delete(key);
            throw new ProxyConfigError(`${via.entry.variable} cannot be used on this Node.js (${process.version}): the proxy support needs Node.js 20.18.1 or newer`);
          },
        );
        agents.set(key, agent);
      }
      // The cast bridges undici's Dispatcher type and the one Node's fetch typings name; it is a valid dispatcher at runtime.
      return await base(input, { ...init, dispatcher: (await agent) as never } as RequestInit);
    } catch (error) {
      if (error instanceof ProxyConfigError) throw error;
      if (!(error instanceof Error)) throw error;
      // The network layer may quote the proxy URL; the cause keeps its error code (ECONNREFUSED, …) for the error mapping.
      const scrubbed = new Error(scrub(error.message, secrets), { cause: error.cause instanceof Error ? Object.assign(new Error(scrub(error.cause.message, secrets)), { code: (error.cause as { code?: unknown }).code }) : undefined });
      scrubbed.name = error.name;
      throw scrubbed;
    }
  };
}
