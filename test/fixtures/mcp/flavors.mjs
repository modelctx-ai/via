// One handler table, two protocol generations. The fixture servers (mock-server.mjs, cli-server.mjs)
// describe what they answer as a table `{ 'tools/list': async (params, h) => result, … }`; this file turns
// it into a server of the old generation (`initialize` handshake, sessions; the 1.x SDK in node_modules)
// or of the stateless one (`server/discover`, `2026-07-28`; the 2.x SDK), so the same tests run against both
// (docs/development/testing.md, "两代协议").
//
// What a handler may use of its context `h`:
//   h.progressToken            the request's progress token, if the client asked for progress
//   h.notify(notification)     send a notification related to this request
//   h.clientCapabilities()     what the client declared
//   h.listRoots()              ask the client for its roots (a result `{ roots }`, or undefined when not declared)
//   h.toolsChanged()           tell listeners the tool list changed
//   h.header(name)             an HTTP request header (stateless protocol over HTTP only; undefined otherwise)
//   h.fail(code, message)      answer with a JSON-RPC error
import { Server as LegacyServer } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CLIENT_CAPABILITIES_META_KEY, inputRequired, ProtocolError, Server as ModernServer } from '@modelcontextprotocol/server';

const LEGACY_SCHEMAS = {
  'completion/complete': CompleteRequestSchema,
  'tools/list': ListToolsRequestSchema,
  'tools/call': CallToolRequestSchema,
  'resources/list': ListResourcesRequestSchema,
  'resources/templates/list': ListResourceTemplatesRequestSchema,
  'resources/read': ReadResourceRequestSchema,
  'prompts/list': ListPromptsRequestSchema,
  'prompts/get': GetPromptRequestSchema,
};

/** Thrown by `h.listRoots()` on a stateless connection: the handler is asked again with the answer. */
class NeedRoots extends Error {}

/**
 * @param {'legacy' | 'modern'} flavor
 * @param {{ name: string, version: string }} info
 * @param {Record<string, unknown>} capabilities
 * @param {Record<string, (params: any, h: any) => Promise<unknown>>} table
 * @param {{ notifier?: { toolsChanged(): void }, instructions?: string }} [options] `notifier`: the stateless handler's `notify` sugar (known only after the handler exists)
 */
export function buildServer(flavor, info, capabilities, table, options = {}) {
  if (flavor === 'legacy') {
    const server = new LegacyServer(info, { capabilities, ...(options.instructions ? { instructions: options.instructions } : {}) });
    for (const [method, handler] of Object.entries(table)) {
      const schema = LEGACY_SCHEMAS[method];
      if (!schema) throw new Error(`flavors.mjs: no legacy schema for ${method}`);
      server.setRequestHandler(schema, (request, extra) =>
        handler(request.params ?? {}, {
          progressToken: extra._meta?.progressToken,
          notify: (notification) => extra.sendNotification(notification),
          clientCapabilities: () => server.getClientCapabilities(),
          listRoots: async () => (server.getClientCapabilities()?.roots ? server.listRoots() : undefined),
          toolsChanged: () => server.sendToolListChanged(),
          header: () => undefined,
          fail: (code, message) => {
            throw new McpError(code, message);
          },
        }),
      );
    }
    return server;
  }
  const server = new ModernServer(info, { capabilities, ...(options.instructions ? { instructions: options.instructions } : {}) });
  for (const [method, handler] of Object.entries(table)) {
    server.setRequestHandler(method, async (request, ctx) => {
      const envelope = ctx.mcpReq.envelope ?? {};
      const h = {
        progressToken: ctx.mcpReq._meta?.progressToken,
        notify: (notification) => ctx.mcpReq.notify(notification),
        clientCapabilities: () => envelope[CLIENT_CAPABILITIES_META_KEY],
        listRoots: async () => {
          if (!envelope[CLIENT_CAPABILITIES_META_KEY]?.roots) return undefined;
          const answered = ctx.mcpReq.inputResponses?.roots;
          if (answered) return answered;
          throw new NeedRoots();
        },
        header: (name) => ctx.http?.req?.headers.get(name) ?? undefined,
        toolsChanged: () => (options.notifier ? options.notifier.toolsChanged() : server.sendToolListChanged()),
        fail: (code, message) => {
          throw new ProtocolError(code, message);
        },
      };
      try {
        return await handler(request.params ?? {}, h);
      } catch (error) {
        if (error instanceof NeedRoots) return inputRequired({ inputRequests: { roots: inputRequired.listRoots() } });
        throw error;
      }
    });
  }
  return server;
}
