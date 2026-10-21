import { createServer, type IncomingHttpHeaders, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CredentialError,
  type ConfigOrigin,
  type CredentialResolver,
  type ServerConfig,
} from '../../src/config/types';
import { modernEndpoint } from '../fixtures/mcp/modern-http.mjs';
import { defaultGeneration, fixtureScript, type Generation } from './generation';
import { createMockServer, createState } from '../fixtures/mcp/mock-server.mjs';

export type { Generation };

/** Obviously fake values; never real credentials. */
export const FAKE_TOKEN = 'fake-token-for-tests';
export const FAKE_KEY = 'fake-api-key-for-tests';

/** The stdio fixture in the default protocol generation (generation.ts). */
export const STDIO_SERVER = fixtureScript('stdio-server', defaultGeneration());

/** Resolves `env:NAME` from a given map, anything else is a literal. Records what it returned. */
export class FakeResolver implements CredentialResolver {
  private readonly values = new Set<string>();

  constructor(private readonly env: Record<string, string> = {}) {}

  async resolve(ref: string, _origin: ConfigOrigin): Promise<string> {
    if (!ref.startsWith('env:')) return ref;
    const name = ref.slice(4);
    const value = this.env[name];
    if (value === undefined) {
      throw new CredentialError(`environment variable ${name} is not set`, ref, `export ${name}=<value>`);
    }
    this.values.add(value);
    return value;
  }

  resolvedValues(): readonly string[] {
    return [...this.values];
  }
}

export function stdioServer(overrides: Partial<ServerConfig> & { env?: Record<string, string>; args?: string[]; command?: string; protocol?: Generation } = {}): ServerConfig {
  const { env, args, command, protocol, ...rest } = overrides;
  return baseConfig({
    transport: { type: 'stdio', command: command ?? process.execPath, args: args ?? [protocol === undefined ? STDIO_SERVER : fixtureScript('stdio-server', protocol)], env: env ?? {} },
    ...rest,
  });
}

export function httpServer(url: string, overrides: Partial<ServerConfig> & { headers?: Record<string, string> } = {}): ServerConfig {
  const { headers, ...rest } = overrides;
  return baseConfig({ transport: { type: 'http', url, headers: headers ?? {} }, ...rest });
}

function baseConfig(overrides: Partial<ServerConfig>): ServerConfig {
  return {
    name: 'mock',
    provider: 'mock',
    transport: { type: 'stdio', command: process.execPath, args: [], env: {} },
    auth: { type: 'none' },
    rename: {},
    disabled: false,
    exclusive: false,
    confirm: 'destructive',
    timeout: 10,
    concurrency: 4,
    noise: [],
    origin: { scope: 'user', path: '/home/test/.config/via/config.yaml' },
    trusted: true,
    ...overrides,
  };
}

export interface MockHttp {
  url: string;
  /** Headers of every request that reached the MCP handler. */
  requests: IncomingHttpHeaders[];
  /** Requests rejected with 401. */
  rejected: number;
  /** Stateless servers: publish `notifications/tools/list_changed` to every open `subscriptions/listen` stream. */
  notifyToolsChanged(): void;
  /** Cut every open connection (a `subscriptions/listen` stream among them) without a goodbye. */
  dropConnections(): void;
  close(): Promise<void>;
}

/**
 * Streamable HTTP mock on an ephemeral localhost port. Requests need
 * `Authorization: Bearer <token>` when `token` is given, otherwise they get 401.
 */
export async function startHttpServer(options: { token?: string; pageSize?: number; status?: number; echoAuth?: boolean; protocol?: Generation; ttlMs?: number } = {}): Promise<MockHttp> {
  const generation = options.protocol ?? defaultGeneration();
  const state = createState();
  const result: MockHttp = { url: '', requests: [], rejected: 0, notifyToolsChanged: () => undefined, dropConnections: () => undefined, close: async () => undefined };
  const modern = generation === 'modern' ? modernEndpoint((notifier) => createMockServer({ pageSize: options.pageSize ?? 0, state, flavor: 'modern', notifier, ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}) })) : undefined;
  if (modern) result.notifyToolsChanged = () => modern.notifier.toolsChanged();

  const http: HttpServer = createServer((req, res) => {
    if (modern) {
      // The stateless endpoint reads the body itself; only the checks below come first.
      if (options.status) {
        const body = options.echoAuth ? `forced failure for ${String(req.headers.authorization)}` : 'forced failure';
        res.writeHead(options.status, { 'content-type': 'text/plain' }).end(body);
        return;
      }
      if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`) {
        result.rejected += 1;
        res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized');
        return;
      }
      result.requests.push(req.headers);
      void modern.handle(req, res);
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        if (options.status) {
          // `echoAuth` mimics a gateway that repeats the request headers in its error body.
          const body = options.echoAuth ? `forced failure for ${String(req.headers.authorization)}` : 'forced failure';
          res.writeHead(options.status, { 'content-type': 'text/plain' }).end(body);
          return;
        }
        if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`) {
          result.rejected += 1;
          res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized');
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405).end();
          return;
        }
        result.requests.push(req.headers);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        // Stateless: one server and transport per request.
        const server = createMockServer({ pageSize: options.pageSize ?? 0, state });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      })();
    });
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  result.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  result.dropConnections = () => http.closeAllConnections();
  result.close = async () => {
    await modern?.close().catch(() => undefined);
    await new Promise<void>((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    });
  };
  return result;
}
