// Mock OAuth authorization server plus an OAuth-protected Streamable HTTP MCP server, for the
// OAuth tests (testing.md, "模拟 server"). Two listeners on 127.0.0.1, like a real deployment:
//  - the authorization server: RFC 8414 metadata, RFC 7591 dynamic registration, authorization
//    code + PKCE (S256 is verified, a wrong verifier is rejected), refresh with rotation, RFC 7009
//    revocation;
//  - the resource server: RFC 9728 protected resource metadata, a 401 with `WWW-Authenticate`
//    pointing at it, and the CLI fixture's tools behind `Authorization: Bearer`.
// "Approving" is automatic: GET /authorize answers with a redirect carrying the code, which is
// what a browser would follow after the person clicks "allow"; `browse()` plays that browser.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createCliServer, createCliState } from './cli-server.mjs';

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');
const token = (prefix) => `${prefix}-${randomBytes(18).toString('hex')}`;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/**
 * @param {{
 *   accessTokenTtl?: number, dcr?: boolean, revocation?: boolean, rotateRefresh?: boolean,
 *   scopes?: string[], idToken?: boolean, refreshTokens?: boolean, cimd?: Record<string, object>
 * }} [options]
 *
 * `machine` enables the client-credentials grant for one client: `{ clientId, clientSecret }` (client_secret_basic or
 * client_secret_post) and/or `{ clientId, publicKey }` (private_key_jwt: the assertion is verified with `jose`).
 * `preRegistered` is a confidential client for the authorization code flow: `{ clientId, clientSecret }`, any loopback
 * redirect URI, the secret required at the token endpoint (Basic or in the body).
 * `state.authorizationServers` replaces the authorization servers the protected resource metadata names.
 *
 * `cimd` maps a client metadata document URL to the document it serves: the server advertises
 * `client_id_metadata_document_supported` and accepts these URLs as `client_id` (without fetching them),
 * checking the redirect URI against the document's `redirect_uris`.
 * `iss` turns on RFC 9207: `true` echoes this server's issuer on the redirect, a string sends that
 * value, and `'omit'` advertises `authorization_response_iss_parameter_supported` without sending `iss`.
 */
export async function startOAuthServer(options = {}) {
  const { accessTokenTtl = 3600, dcr = true, revocation = true, rotateRefresh = true, scopes = ['read', 'write'], idToken = false, refreshTokens = true, cimd, machine, preRegistered, iss } = options;
  const lookupClient = (id) => clients.get(id) ?? (cimd && Object.hasOwn(cimd, id) ? cimd[id] : undefined);

  const clients = new Map(); // client_id -> registered metadata
  if (preRegistered) clients.set(preRegistered.clientId, { client_id: preRegistered.clientId, client_secret: preRegistered.clientSecret, redirect_uris: [], anyLoopback: true });
  const codes = new Map(); // code -> grant
  const accessTokens = new Map(); // access token -> { expiresAt, scope, clientId }
  const refreshGrants = new Map(); // refresh token -> { clientId, scope, active }

  const state = {
    registrations: [],
    authorizeRequests: [],
    tokenRequests: [],
    /** One entry per token request: grant, client id as presented, and how the client authenticated (basic, post, jwt, none). */
    tokenAuth: [],
    revocations: [],
    /** One entry per request that reached the MCP endpoint: whether it carried a valid token. */
    mcp: [],
    cli: createCliState(),
    /** When set, the protected resource metadata names these authorization servers instead of this one. */
    authorizationServers: undefined,
    /** Deny the next authorization (answers with `error=access_denied`). */
    denyNext: false,
    /** When set, the token endpoint answers every request with this HTTP status. */
    tokenFailure: undefined,
    /** When set, requests with a valid token get this status; `echo` repeats the Authorization header in the body. */
    mcpFailure: undefined,
  };

  let asOrigin = '';
  let resourceOrigin = '';
  const mcpPath = '/mcp';

  // Authorization server ----------------------------------------------------------------------

  const authServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', asOrigin || 'http://127.0.0.1');
      if (req.method === 'GET' && (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname.startsWith('/.well-known/openid-configuration'))) {
        return json(res, 200, {
          issuer: asOrigin,
          authorization_endpoint: `${asOrigin}/authorize`,
          token_endpoint: `${asOrigin}/token`,
          ...(cimd ? { client_id_metadata_document_supported: true } : {}),
          ...(dcr ? { registration_endpoint: `${asOrigin}/register` } : {}),
          ...(revocation ? { revocation_endpoint: `${asOrigin}/revoke` } : {}),
          response_types_supported: ['code'],
          grant_types_supported: [...(machine ? ['client_credentials'] : []), 'authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          ...(iss !== undefined ? { authorization_response_iss_parameter_supported: true } : {}),
          token_endpoint_auth_methods_supported: machine || preRegistered ? ['none', 'client_secret_basic', 'client_secret_post', ...(machine?.publicKey ? ['private_key_jwt'] : [])] : ['none'],
          ...(machine?.publicKey ? { token_endpoint_auth_signing_alg_values_supported: ['ES256'] } : {}),
          scopes_supported: scopes,
        });
      }

      if (req.method === 'POST' && url.pathname === '/register') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
        if (redirects.length === 0 || !redirects.every((u) => /^http:\/\/127\.0\.0\.1(:\d+)?\//.test(u))) {
          return json(res, 400, { error: 'invalid_redirect_uri', error_description: 'only loopback redirect URIs are accepted' });
        }
        const clientId = token('client');
        const registered = { ...body, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) };
        clients.set(clientId, registered);
        state.registrations.push(registered);
        return json(res, 201, registered);
      }

      if (req.method === 'GET' && url.pathname === '/authorize') {
        const q = url.searchParams;
        state.authorizeRequests.push(Object.fromEntries(q));
        const client = lookupClient(q.get('client_id') ?? '');
        const redirect = q.get('redirect_uri');
        const loopback = client?.anyLoopback && /^http:\/\/127\.0\.0\.1:\d+\//.test(redirect ?? '');
        if (!client || !redirect || !(loopback || client.redirect_uris.includes(redirect))) {
          return json(res, 400, { error: 'invalid_request', error_description: 'unknown client or redirect_uri' });
        }
        const target = new URL(redirect);
        if (q.get('state')) target.searchParams.set('state', q.get('state'));
        if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
          target.searchParams.set('error', 'invalid_request');
        } else if (state.denyNext) {
          state.denyNext = false;
          target.searchParams.set('error', 'access_denied');
          target.searchParams.set('error_description', 'The user said no');
        } else {
          const code = token('code');
          codes.set(code, {
            clientId: q.get('client_id'),
            redirect,
            challenge: q.get('code_challenge'),
            scope: q.get('scope') ?? scopes.join(' '),
            resource: q.get('resource'),
          });
          target.searchParams.set('code', code);
          if (iss === true) target.searchParams.set('iss', asOrigin);
          else if (typeof iss === 'string' && iss !== 'omit') target.searchParams.set('iss', iss);
        }
        res.writeHead(302, { location: target.href }).end();
        return;
      }

      if (req.method === 'POST' && url.pathname === '/token') {
        const form = new URLSearchParams(await readBody(req));
        state.tokenRequests.push(Object.fromEntries(form));
        if (state.tokenFailure) return json(res, state.tokenFailure, { error: 'server_error' });
        const grantType = form.get('grant_type');
        let clientId = form.get('client_id') ?? '';
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
        let presentedSecret = form.get('client_secret') ?? undefined;
        if (basic) {
          const [id, secret] = Buffer.from(basic[1], 'base64').toString('utf8').split(':').map(decodeURIComponent);
          clientId = id ?? clientId;
          presentedSecret = secret;
        }
        state.tokenAuth.push({ grantType, clientId, method: basic ? 'basic' : presentedSecret !== undefined ? 'post' : form.get('client_assertion') ? 'jwt' : 'none' });

        if (grantType === 'client_credentials') {
          const invalid = (why) => json(res, 401, { error: 'invalid_client', error_description: why });
          if (!machine) return json(res, 400, { error: 'unsupported_grant_type' });
          const assertion = form.get('client_assertion');
          if (assertion) {
            if (!machine.publicKey) return invalid('assertions are not accepted');
            try {
              const { jwtVerify } = await import('jose');
              const { payload } = await jwtVerify(assertion, machine.publicKey, { audience: [asOrigin, `${asOrigin}/`, `${asOrigin}/token`] });
              if (payload.iss !== machine.clientId || payload.sub !== machine.clientId) return invalid('wrong iss or sub');
            } catch (error) {
              return invalid(`assertion rejected: ${error.message}`);
            }
          } else if (clientId !== machine.clientId || machine.clientSecret === undefined || presentedSecret !== machine.clientSecret) {
            return invalid('unknown client or wrong secret');
          }
          const access = token('cc');
          const granted = form.get('scope') ?? scopes.join(' ');
          accessTokens.set(access, { expiresAt: Date.now() + accessTokenTtl * 1000, scope: granted, clientId });
          return json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: accessTokenTtl, scope: granted });
        }

        if (!lookupClient(clientId)) return json(res, 401, { error: 'invalid_client' });
        const known = clients.get(clientId);
        if (known?.client_secret !== undefined && presentedSecret !== known.client_secret) return json(res, 401, { error: 'invalid_client', error_description: 'wrong secret' });

        let scope;
        if (grantType === 'authorization_code') {
          const grant = codes.get(form.get('code') ?? '');
          codes.delete(form.get('code') ?? '');
          if (!grant || grant.clientId !== clientId || grant.redirect !== form.get('redirect_uri')) {
            return json(res, 400, { error: 'invalid_grant', error_description: 'unknown code or redirect_uri mismatch' });
          }
          const verifier = form.get('code_verifier') ?? '';
          if (b64url(createHash('sha256').update(verifier).digest()) !== grant.challenge) {
            return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
          }
          scope = grant.scope;
        } else if (grantType === 'refresh_token') {
          const old = refreshGrants.get(form.get('refresh_token') ?? '');
          if (!old || !old.active || old.clientId !== clientId) return json(res, 400, { error: 'invalid_grant', error_description: 'refresh token is not valid' });
          if (rotateRefresh) old.active = false;
          scope = old.scope;
        } else {
          return json(res, 400, { error: 'unsupported_grant_type' });
        }

        const access = token('at');
        accessTokens.set(access, { expiresAt: Date.now() + accessTokenTtl * 1000, scope, clientId });
        const body = { access_token: access, token_type: 'Bearer', expires_in: accessTokenTtl, scope };
        if (refreshTokens) {
          // Without rotation the same refresh token keeps working (the SDK keeps the old one when none is returned).
          let refresh = grantType === 'refresh_token' && !rotateRefresh ? form.get('refresh_token') : undefined;
          if (!refresh) {
            refresh = token('rt');
            refreshGrants.set(refresh, { clientId, scope, active: true });
          }
          if (grantType === 'authorization_code' || rotateRefresh) body.refresh_token = refresh;
        }
        if (idToken) {
          const part = (o) => b64url(JSON.stringify(o));
          body.id_token = `${part({ alg: 'none' })}.${part({ sub: 'user-1', email: 'user@example.com' })}.`;
        }
        return json(res, 200, body);
      }

      if (req.method === 'POST' && url.pathname === '/revoke') {
        const form = new URLSearchParams(await readBody(req));
        state.revocations.push(Object.fromEntries(form));
        const value = form.get('token') ?? '';
        accessTokens.delete(value);
        const grant = refreshGrants.get(value);
        if (grant) grant.active = false;
        res.writeHead(200).end();
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    })();
  });

  // Resource server ---------------------------------------------------------------------------

  const prmPath = `/.well-known/oauth-protected-resource${mcpPath}`;
  const resourceServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', resourceOrigin || 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return json(res, 200, { resource: `${resourceOrigin}${mcpPath}`, authorization_servers: state.authorizationServers ?? [asOrigin], scopes_supported: scopes });
      }
      if (url.pathname !== mcpPath) {
        res.writeHead(404).end();
        return;
      }
      const header = req.headers.authorization ?? '';
      const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
      const grant = accessTokens.get(bearer);
      const valid = grant !== undefined && grant.expiresAt > Date.now();
      state.mcp.push({ valid, authorization: header });
      const body = await readBody(req);
      if (!valid) {
        res
          .writeHead(401, {
            'content-type': 'text/plain',
            'www-authenticate': `Bearer resource_metadata="${resourceOrigin}${prmPath}", scope="${scopes.join(' ')}"`,
          })
          .end('unauthorized');
        return;
      }
      if (state.mcpFailure) {
        res.writeHead(state.mcpFailure.status, { 'content-type': 'text/plain' }).end(state.mcpFailure.echo ? `forced failure for ${header}` : 'forced failure');
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      const server = createCliServer({ state: state.cli, authorization: header });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, JSON.parse(body));
    })();
  });

  const asPort = await listen(authServer);
  const resourcePort = await listen(resourceServer);
  asOrigin = `http://127.0.0.1:${asPort}`;
  resourceOrigin = `http://127.0.0.1:${resourcePort}`;

  return {
    /** The protected MCP endpoint. */
    url: `${resourceOrigin}${mcpPath}`,
    issuer: asOrigin,
    state,
    /** Every access token the server has issued and not revoked, newest last. */
    issuedAccessTokens: () => [...accessTokens.keys()],
    issuedRefreshTokens: () => [...refreshGrants.keys()],
    /** Make the access tokens issued so far unusable (the server forgot them): the next call sees 401. */
    expireAccessTokens: () => accessTokens.clear(),
    /** Make every refresh token fail with `invalid_grant`. */
    revokeRefreshTokens: () => {
      for (const grant of refreshGrants.values()) grant.active = false;
    },
    /**
     * What a browser does after the person approves: open the authorization URL, follow the redirect
     * to the client's redirect URI. Resolves with that last response (the loopback's page).
     */
    async browse(authorizationUrl) {
      const first = await fetch(authorizationUrl, { redirect: 'manual' });
      const location = first.headers.get('location');
      if (!location) throw new Error(`authorization server did not redirect (HTTP ${first.status})`);
      const landed = await fetch(location, { redirect: 'manual' });
      return { status: landed.status, text: await landed.text(), location };
    },
    /** Like `browse`, but stops at the redirect: the URL the browser would land on. */
    async approve(authorizationUrl) {
      const first = await fetch(authorizationUrl, { redirect: 'manual' });
      const location = first.headers.get('location');
      if (!location) throw new Error(`authorization server did not redirect (HTTP ${first.status})`);
      return location;
    },
    close: () =>
      Promise.all(
        [authServer, resourceServer].map(
          (server) =>
            new Promise((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve(undefined));
            }),
        ),
      ).then(() => undefined),
  };
}
