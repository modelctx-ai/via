// `via prompt` (guides/agent-integration.md): the agent-facing instructions plus a domain summary.
// CONTRACT STUB.
import type { Catalog } from '../catalog';

export interface PromptInput {
  catalog: Catalog;
  /** Custom domains from config, in config order (discovery.md domain ordering). */
  customDomainOrder?: readonly string[];
}

export function renderPrompt(input: PromptInput): string {
  void input;
  throw new Error('renderPrompt: not implemented');
}
