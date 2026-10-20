import { createServer, type IncomingHttpHeaders, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CredentialError,
  type ConfigOrigin,
  type CredentialResolver,
  type ServerConfig,
} from '../../src/config/types';
import { createMockServer, createState } from '../fixtures/mcp/mock-server.mjs';

/** Obviously fake values; never real credentials. */
export const FAKE_TOKEN = 'fake-token-for-tests';
export const FAKE_KEY = 'fake-api-key-for-tests';

export const STDIO_SERVER = fileURLToPath(new URL('../fixtures/mcp/stdio-server.mjs', import.meta.url));

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

export function stdioServer(overrides: Partial<ServerConfig> & { env?: Record<string, string>; args?: string[]; command?: string } = {}): ServerConfig {
  const { env, args, command, ...rest } = overrides;
  return baseConfig({
    transport: { type: 'stdio', command: command ?? process.execPath, args: args ?? [STDIO_SERVER], env: env ?? {} },
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
  close(): Promise<void>;
}

/**
 * Streamable HTTP mock on an ephemeral localhost port. Requests need
 * `Authorization: Bearer <token>` when `token` is given, otherwise they get 401.
 */
export async function startHttpServer(options: { token?: string; pageSize?: number; status?: number; echoAuth?: boolean } = {}): Promise<MockHttp> {
  const state = createState();
  const result: MockHttp = { url: '', requests: [], rejected: 0, close: async () => undefined };

  const http: HttpServer = createServer((req, res) => {
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
  result.close = () =>
    new Promise<void>((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    });
  return result;
}
