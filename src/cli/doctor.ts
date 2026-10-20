// `via doctor` (guides/agent-integration.md): connection and auth status per server, frameworks
// still injecting MCP schemas with their disable hints, plaintext secrets. CONTRACT STUB.
import type { FrameworkDef, LoadedConfig } from '../config';

/** Result of probing one server (done by the CLI with the client; doctor only renders). */
export interface ServerProbe {
  /** Key under `servers`. */
  server: string;
  provider: string;
  status: 'ok' | 'needs-auth' | 'error' | 'untrusted' | 'disabled';
  /** Short reason for non-ok statuses, already redacted. */
  message?: string;
  toolCount?: number;
  /** Length of the serialized `tools/list` result, for the tokens/turn estimate. */
  schemaBytes?: number;
}

export interface DoctorInput {
  config: LoadedConfig;
  frameworks: readonly FrameworkDef[];
  probes: readonly ServerProbe[];
}

export interface DoctorOutput {
  text: string;
  /** 0 when everything is usable; see the implementation for the non-zero cases. */
  exitCode: number;
}

export function renderDoctor(input: DoctorInput): DoctorOutput {
  void input;
  throw new Error('renderDoctor: not implemented');
}
