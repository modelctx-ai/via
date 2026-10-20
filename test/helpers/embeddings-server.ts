// A local OpenAI-compatible `/v1/embeddings` server with deterministic fake vectors, for the tests
// of optional embedding retrieval. A text becomes a bag of "concepts": every word maps to a concept
// (through `concepts`, else itself) and every concept to one dimension, so texts sharing concepts
// are close and the test controls what counts as similar.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';

export interface EmbeddingsRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: { model?: string; input?: string[]; dimensions?: number; encoding_format?: string };
}

export interface EmbeddingsServerOptions {
  /** Requires `Authorization: Bearer <token>`; anything else is a 401 whose body echoes the header. */
  token?: string;
  /** Word -> concept; words not listed are their own concept. */
  concepts?: Record<string, string>;
  dimensions?: number;
  /** Delay before answering, in ms. */
  delayMs?: number;
  /** Answer every request with this status and an echo of the request in the body. */
  status?: number;
  /** Answer with this raw body (HTTP 200). */
  rawBody?: string;
  /** Redirect to this URL. */
  redirectTo?: string;
  /** Fail with HTTP 500 once this many requests have been answered. */
  failAfter?: number;
}

export interface EmbeddingsServer {
  /** Base URL, `http://127.0.0.1:<port>/v1`. */
  url: string;
  requests: EmbeddingsRequest[];
  /** Total texts embedded. */
  inputs(): number;
  /** Change the behaviour of a running server. */
  set(options: Partial<Pick<EmbeddingsServerOptions, 'delayMs' | 'failAfter' | 'status'>>): void;
  close(): Promise<void>;
}

const hash = (s: string): number => createHash('sha256').update(s).digest().readUInt32LE(0);

export function fakeEmbedding(text: string, dims: number, concepts: Record<string, string> = {}): number[] {
  const v: number[] = new Array<number>(dims).fill(0);
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const stem = word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
    const concept = concepts[word] ?? concepts[stem] ?? stem;
    v[hash(concept) % dims]! += 1;
  }
  // An all-zero vector has no direction.
  if (!v.some((x) => x !== 0)) v[0] = 1;
  return v;
}

export async function startEmbeddingsServer(initial: EmbeddingsServerOptions = {}): Promise<EmbeddingsServer> {
  const options: EmbeddingsServerOptions = { ...initial };
  const dims = options.dimensions ?? 64;
  const requests: EmbeddingsRequest[] = [];
  const http: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const respond = () => {
        if (options.redirectTo) {
          res.writeHead(307, { location: options.redirectTo }).end();
          return;
        }
        if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`) {
          // A careless server that repeats what it received.
          res.writeHead(401, { 'content-type': 'text/plain' }).end(`bad credentials: ${String(req.headers.authorization)}`);
          return;
        }
        if (options.status !== undefined) {
          res.writeHead(options.status, { 'content-type': 'text/plain' }).end(`error: ${text} ${String(req.headers.authorization)}`);
          return;
        }
        if (options.rawBody !== undefined) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(options.rawBody);
          return;
        }
        if (options.failAfter !== undefined && requests.length >= options.failAfter) {
          res.writeHead(500).end('overloaded');
          return;
        }
        const body = JSON.parse(text) as EmbeddingsRequest['body'];
        requests.push({ path: req.url ?? '', headers: req.headers, body });
        const size = body.dimensions ?? dims;
        const data = (body.input ?? []).map((input, index) => ({ object: 'embedding', index, embedding: fakeEmbedding(input, size, options.concepts) }));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data, model: body.model }));
      };
      if (options.delayMs) setTimeout(respond, options.delayMs);
      else respond();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`,
    requests,
    set: (change) => void Object.assign(options, change),
    inputs: () => requests.reduce((n, r) => n + (r.body.input?.length ?? 0), 0),
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
