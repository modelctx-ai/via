// Token estimation: the same 4-bytes-per-token rule `via doctor` uses (agent-integration.md), so
// the benchmark and the doctor's per-turn figure are directly comparable.
import { BYTES_PER_TOKEN } from '../../src/cli/doctor';

export { BYTES_PER_TOKEN };

export const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');

export const estimateTokens = (bytes: number): number => Math.round(bytes / BYTES_PER_TOKEN);
