import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from '@modelcontextprotocol/server';

export declare function modernEndpoint(
  makeServer: (notifier: { toolsChanged(): void }) => Server,
  options?: { legacy?: 'reject' | 'stateless' },
): {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  notifier: { toolsChanged(): void };
  close(): Promise<void>;
};
