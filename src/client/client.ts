import type { McpTool } from '../catalog/types';
import type { CredentialResolver, ServerConfig } from '../config/types';
import type { CompletionRef, CompletionResult, GetPromptResult, McpPrompt, ProtocolInfo, ReadResourceResult, ResourceListing, ServerFeatures, ServerSelf, SkillEntry, SkillRead, ToolCallResult } from '../protocol';
import { notFoundServer } from './errors';
import { McpSession, type CallOptions, type ListOptions, type SessionOptions } from './session';

/**
 * What the CLI needs from "something that talks to MCP servers". The in-process client implements it
 * now; the daemon's socket client will implement the same interface (daemon.md). Failures are thrown
 * as `ClientError`, which carries a protocol `ErrorInfo`.
 */
export interface McpClient {
  listTools(server: string, options?: ListOptions): Promise<McpTool[]>;
  callTool(server: string, rawName: string, args?: Record<string, unknown>, options?: CallOptions): Promise<ToolCallResult>;
  /** `resources/list` and `resources/templates/list` (ADR 0010). */
  listResources(server: string, options?: ListOptions): Promise<ResourceListing>;
  readResource(server: string, uri: string, options?: ListOptions): Promise<ReadResourceResult>;
  listPrompts(server: string, options?: ListOptions): Promise<McpPrompt[]>;
  getPrompt(server: string, name: string, args: Record<string, string>, options?: ListOptions): Promise<GetPromptResult>;
  /** `skills/list` (the skills extension; ADR 0020). */
  listSkills(server: string, options?: ListOptions): Promise<SkillEntry[]>;
  /** One file of a skill, verified against its manifest. `skill` is the URI of its `SKILL.md`; `file` is relative to its directory. */
  readSkill(server: string, skill: string, file?: string, options?: ListOptions): Promise<SkillRead>;
  /** `completion/complete` for an argument of a prompt or resource template. */
  complete(server: string, ref: CompletionRef, argument: { name: string; value: string }, context?: Record<string, string>, options?: ListOptions): Promise<CompletionResult>;
  /** What the server declared at `initialize`, once a session to it exists; undefined if unknown. */
  features(server: string): ServerFeatures | undefined;
  /** What the server says about itself (`serverInfo`, `instructions`), once a session to it exists; undefined if unknown. */
  info(server: string): ServerSelf | undefined;
  /** The protocol version the session to the server negotiated and whether it is stateful; undefined while not connected. */
  protocol(server: string): ProtocolInfo | undefined;
  close(): Promise<void>;
}

/**
 * Direct connections from the current process (`VIA_NO_DAEMON=1`, CI, daemon fallback). Sessions are
 * created on first use and kept until `close()`, so repeated calls within one run reuse them.
 * Credentials are resolved right before each connection and stay in memory.
 */
export class InProcessClient implements McpClient {
  private readonly sessions = new Map<string, McpSession>();

  constructor(
    private readonly servers: readonly ServerConfig[],
    private readonly resolver: CredentialResolver,
    private readonly options: SessionOptions = {},
  ) {}

  /** `server` is the config key (`ServerConfig.name`) or the provider name. */
  async listTools(server: string, options?: ListOptions): Promise<McpTool[]> {
    return this.session(server).listTools(options);
  }

  async callTool(server: string, rawName: string, args?: Record<string, unknown>, options?: CallOptions): Promise<ToolCallResult> {
    return this.session(server).callTool(rawName, args, options);
  }

  async listResources(server: string, options?: ListOptions): Promise<ResourceListing> {
    return this.session(server).listResources(options);
  }

  async readResource(server: string, uri: string, options?: ListOptions): Promise<ReadResourceResult> {
    return this.session(server).readResource(uri, options);
  }

  async listPrompts(server: string, options?: ListOptions): Promise<McpPrompt[]> {
    return this.session(server).listPrompts(options);
  }

  async getPrompt(server: string, name: string, args: Record<string, string>, options?: ListOptions): Promise<GetPromptResult> {
    return this.session(server).getPrompt(name, args, options);
  }

  async listSkills(server: string, options?: ListOptions): Promise<SkillEntry[]> {
    return this.session(server).listSkills(options);
  }

  async readSkill(server: string, skill: string, file?: string, options?: ListOptions): Promise<SkillRead> {
    return this.session(server).readSkill(skill, file, options);
  }

  async complete(server: string, ref: CompletionRef, argument: { name: string; value: string }, context?: Record<string, string>, options?: ListOptions): Promise<CompletionResult> {
    return this.session(server).complete(ref, argument, context, options);
  }

  features(server: string): ServerFeatures | undefined {
    return this.sessions.get(this.find(server).name)?.features();
  }

  info(server: string): ServerSelf | undefined {
    return this.sessions.get(this.find(server).name)?.info();
  }

  protocol(server: string): ProtocolInfo | undefined {
    return this.sessions.get(this.find(server).name)?.protocol();
  }

  /** Close every session and kill stdio children. */
  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((s) => s.close()));
  }

  private session(key: string): McpSession {
    const config = this.find(key);
    let session = this.sessions.get(config.name);
    if (!session) {
      session = new McpSession(config, this.resolver, this.options);
      this.sessions.set(config.name, session);
    }
    return session;
  }

  /** Disabled servers are hidden from via (config.md), so they are "not found" like unknown ones. */
  private find(key: string): ServerConfig {
    const visible = this.servers.filter((s) => !s.disabled);
    const found = visible.find((s) => s.name === key) ?? visible.find((s) => s.provider === key);
    if (found) return found;
    const near = visible
      .map((s) => s.provider)
      .filter((p) => p.includes(key) || key.includes(p))
      .slice(0, 5);
    throw notFoundServer(key, near);
  }
}
