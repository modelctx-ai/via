// `via auth login` (auth.md, "流程"): discovery, registration, PKCE authorization and the token
// exchange, driven by the SDK's `auth()` through ViaOAuthProvider. Interaction with the person
// (showing the URL, opening a browser, reading a pasted URL) goes through `LoginIO`, so the flow
// is the same for the terminal, for tests and for anything else that wants to log in.
import { randomBytes } from 'node:crypto';
import pkg from '../../../package.json';
import { MODERN_PROTOCOL_VERSIONS } from '../../protocol-versions';
import { LoginFailedError, oauthErrorCode } from './errors';
import type { OpenResult } from './opener';
import { ViaOAuthProvider } from './provider';
import { CALLBACK_PORTS, CallbackPortsBusyError, callbackUrl, parseRedirect, startLoopback, type AuthorizationResponse, type Loopback } from './redirect';
import type { OAuthRecord, OAuthStore, SetResult } from './store';
import type { FetchLike } from '@modelcontextprotocol/client';

export interface LoginIO {
  /** The authorization URL, shown to the person as soon as it is known. */
  showUrl(url: string): void;
  /** A progress or hint line. */
  note(text: string): void;
  /** Open the URL in a browser; must not block or throw. */
  openUrl(url: string): Promise<OpenResult>;
  /** One line from the terminal; undefined at end of input. */
  readLine(prompt: string): Promise<string | undefined>;
}

export interface LoginTarget {
  provider: string;
  /** The MCP endpoint. */
  url: string;
  scopes?: readonly string[];
  clientId?: string;
  /** Client ID Metadata Document URL (CIMD) to offer as `client_id`; absent: dynamic registration only. */
  clientMetadataUrl?: string;
}

export interface LoginOptions {
  target: LoginTarget;
  store: OAuthStore;
  /** Print the URL and read the redirect from the terminal; no browser, no listener. */
  manual: boolean;
  /** How long to wait for the authorization to finish. */
  timeoutMs: number;
  io: LoginIO;
  /** Loopback ports to try, in order; default: the fixed range of the client metadata document. */
  callbackPorts?: readonly number[];
  track?: (value: string) => void;
  now?: () => number;
  fetch?: FetchLike;
}

export interface LoginResult {
  record: OAuthRecord;
  set: SetResult;
}

const MANUAL_ATTEMPTS = 3;

/** What an unauthenticated request to the server says about how to authorize (RFC 9728 / 6750). */
async function probeChallenge(url: string, fetchFn: FetchLike | undefined): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
  try {
    const sdk = await import('@modelcontextprotocol/client');
    const send = fetchFn ?? ((u, init) => fetch(u, init));
    const clientInfo = { name: 'via', version: pkg.version };
    // One request per protocol generation, newest first: a server answers either with the challenge
    // (an unauthenticated request is refused before it is understood) or with "not for me", and the
    // second try covers a server that only understands the other generation. The versions are the
    // SDK's and via's own list (protocol-versions.ts), never a literal here.
    const modern = MODERN_PROTOCOL_VERSIONS[0]!;
    const probes: Array<{ headers: Record<string, string>; body: unknown }> = [
      {
        headers: { 'mcp-protocol-version': modern, 'mcp-method': 'server/discover' },
        body: {
          jsonrpc: '2.0',
          id: 0,
          method: 'server/discover',
          params: { _meta: { [sdk.PROTOCOL_VERSION_META_KEY]: modern, [sdk.CLIENT_INFO_META_KEY]: clientInfo, [sdk.CLIENT_CAPABILITIES_META_KEY]: {} } },
        },
      },
      {
        headers: {},
        body: { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: sdk.LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo } },
      },
    ];
    for (const probe of probes) {
      const response = await send(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...probe.headers },
        body: JSON.stringify(probe.body),
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) return sdk.extractWWWAuthenticateParams(response);
    }
    return {};
  } catch {
    return {}; // discovery by well-known paths still works without it
  }
}

function describeOAuthError(error: Error): string {
  const text = error.message.split('\n')[0] ?? '';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Map what the SDK throws during login to a failure with an exit code. */
function loginFailure(error: unknown, target: LoginTarget): LoginFailedError {
  if (error instanceof LoginFailedError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/dynamic client registration/i.test(message)) {
    return new LoginFailedError(
      `${target.provider}'s authorization server does not support dynamic client registration`,
      2,
      `register a client there and set servers.${target.provider}.auth to { oauth: { clientId: "<id>" } }`,
    );
  }
  const code = oauthErrorCode(error);
  if (typeof code === 'string') return new LoginFailedError(`${target.provider}: the authorization server refused the request (${code}): ${describeOAuthError(error as Error)}`, 4);
  const host = (() => {
    try {
      return new URL(target.url).origin;
    } catch {
      return 'the server';
    }
  })();
  const network = error instanceof TypeError || /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|timed out/i.test(message);
  return new LoginFailedError(
    network ? `cannot reach ${host} to log in to ${target.provider}` : `${target.provider}: login failed: ${message.split('\n')[0] ?? 'unknown error'}`,
    6,
    'via doctor',
  );
}

function timeoutAfter<T>(ms: number, promise: Promise<T>, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function readManual(io: LoginIO, provider: string): Promise<AuthorizationResponse> {
  for (let attempt = 1; attempt <= MANUAL_ATTEMPTS; attempt += 1) {
    const line = await io.readLine('paste the redirect URL: ');
    if (line === undefined) break;
    const parsed = parseRedirect(line);
    if (parsed) return parsed;
    // An empty answer is end of input: asking again would only get the same.
    if (line.trim() === '') break;
    if (attempt < MANUAL_ATTEMPTS) io.note('that does not contain a code or an error; paste the full URL of the page the browser ended up on');
  }
  throw new LoginFailedError(`${provider}: no redirect URL with an authorization code was given`, 4, `via auth login ${provider} --manual`);
}

/**
 * Run the login. Resolves with the stored record; throws LoginFailedError otherwise. Nothing is
 * stored unless the whole flow succeeds.
 */
export async function performLogin(options: LoginOptions): Promise<LoginResult> {
  const { target, io } = options;
  const sdk = await import('@modelcontextprotocol/client');
  const state = randomBytes(24).toString('base64url');
  let loopback: Loopback | undefined;
  const ports = options.callbackPorts ?? CALLBACK_PORTS;
  try {
    loopback = options.manual ? undefined : await startLoopback(ports);
  } catch (error) {
    const reason = error instanceof CallbackPortsBusyError ? error.message : 'cannot listen on 127.0.0.1 for the authorization response';
    throw new LoginFailedError(`${target.provider}: ${reason}`, 6, `via auth login ${target.provider} --manual`);
  }
  // Without a listener (`--manual`) the redirect URI is the first port of the range: nothing listens, the page the
  // browser lands on does not load, and the URI is still one the client metadata document lists.
  const redirectUrl = loopback?.redirectUrl ?? callbackUrl(ports[0]!);
  let authorizationUrl: URL | undefined;
  const provider = new ViaOAuthProvider({
    serverUrl: target.url,
    ...(target.scopes ? { scopes: target.scopes } : {}),
    ...(target.clientId ? { clientId: target.clientId } : {}),
    ...(target.clientMetadataUrl ? { clientMetadataUrl: target.clientMetadataUrl } : {}),
    store: options.store,
    ...(options.track ? { track: options.track } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    login: {
      redirectUrl,
      state,
      onAuthorizationUrl: (url) => {
        authorizationUrl = url;
      },
    },
  });

  try {
    const challenge = await probeChallenge(target.url, options.fetch);
    const configuredScope = target.scopes && target.scopes.length > 0 ? target.scopes.join(' ') : undefined;
    const scope = configuredScope ?? challenge.scope;
    const common = {
      serverUrl: target.url,
      ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
      ...(scope ? { scope } : {}),
      ...(options.fetch ? { fetchFn: options.fetch } : {}),
    };

    let started: Awaited<ReturnType<typeof sdk.auth>>;
    try {
      started = await sdk.auth(provider, common);
    } catch (error) {
      throw loginFailure(error, target);
    }
    if (started !== 'REDIRECT' || !authorizationUrl) {
      throw new LoginFailedError(`${target.provider}: the authorization server did not start an authorization`, 6, 'via doctor');
    }

    const url = authorizationUrl.href;
    const clientId = authorizationUrl.searchParams.get('client_id');
    if (target.clientMetadataUrl && clientId === target.clientMetadataUrl) {
      io.note(`client id: ${clientId} (client ID metadata document; set auth.oauth.clientMetadataUrl: false to register dynamically instead)`);
    }
    io.showUrl(url);
    let response: AuthorizationResponse;
    const timeoutError = (): Error =>
      new LoginFailedError(`${target.provider}: timed out waiting for the authorization after ${Math.round(options.timeoutMs / 1000)}s`, 4, `via auth login ${target.provider}${options.manual ? ' --manual' : ''}`);
    if (loopback) {
      const opened = await io.openUrl(url);
      io.note(opened.opened ? 'opened the URL in your browser' : `not opening a browser (${opened.reason ?? 'unavailable'}); open the URL yourself, or run on a headless machine with --manual`);
      io.note(`waiting for the authorization on ${loopback.redirectUrl}`);
      response = await timeoutAfter(options.timeoutMs, loopback.response, timeoutError);
    } else {
      io.note('open the URL in a browser on any machine; after you approve, the browser lands on a page that does not load: copy that page\'s full URL');
      response = await timeoutAfter(options.timeoutMs, readManual(io, target.provider), timeoutError);
    }

    if (response.error) {
      const detail = response.errorDescription ? `: ${response.errorDescription.slice(0, 200)}` : '';
      throw new LoginFailedError(`${target.provider}: authorization was not granted (${response.error})${detail}`, 4, `via auth login ${target.provider}`);
    }
    if (response.state !== state) {
      throw new LoginFailedError(
        `${target.provider}: the authorization response does not belong to this login (state mismatch)`,
        4,
        `via auth login ${target.provider}${options.manual ? ' --manual' : ''}`,
      );
    }
    try {
      await sdk.auth(provider, { ...common, authorizationCode: response.code! });
    } catch (error) {
      throw loginFailure(error, target);
    }
    const record = await provider.load(true);
    if (!record?.tokens || !provider.lastSet) throw new LoginFailedError(`${target.provider}: the login was not saved`, 6, 'via doctor');
    return { record, set: provider.lastSet };
  } finally {
    await loopback?.close();
  }
}
