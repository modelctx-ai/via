// A forward HTTP proxy on a loopback port, for the tests of via's own outbound requests (docs/spec/config.md,
// "代理"): plain requests (absolute-form URL) are forwarded, CONNECT tunnels are piped. It records what it
// was asked to carry, including the credentials the client presented to it.
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';

export interface ProxyLog {
  /** `GET http://127.0.0.1:1234/mcp` for a forwarded request, `CONNECT 127.0.0.1:1234` for a tunnel. */
  line: string;
  /** The `Proxy-Authorization` header the client sent. */
  authorization?: string;
}

export interface ProxyServer {
  /** `http://127.0.0.1:<port>`. */
  url: string;
  log: ProxyLog[];
  close(): Promise<void>;
}

/** `refuseTunnels`: answer every CONNECT with this status instead of opening it, as srt's proxy does for a domain its policy does not allow. */
export async function startProxy(options: { refuseTunnels?: number } = {}): Promise<ProxyServer> {
  const log: ProxyLog[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    log.push({ line: `${req.method} ${req.url}`, ...(req.headers['proxy-authorization'] ? { authorization: String(req.headers['proxy-authorization']) } : {}) });
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('absolute URL expected');
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = httpRequest({ host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: req.method, headers }, (back: IncomingMessage) => {
      res.writeHead(back.statusCode ?? 502, back.headers);
      back.pipe(res);
    });
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (req, client: Socket, head) => {
    log.push({ line: `CONNECT ${req.url}`, ...(req.headers['proxy-authorization'] ? { authorization: String(req.headers['proxy-authorization']) } : {}) });
    if (options.refuseTunnels !== undefined) {
      client.end(`HTTP/1.1 ${options.refuseTunnels} Refused\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const [host, port] = String(req.url).split(':');
    const upstream = connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    log,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
