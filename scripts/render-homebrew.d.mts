export const PACKAGE: string;
export const REGISTRY: string;
export function tarballUrl(version: string): string;
export function sha256Hex(buffer: Uint8Array): string;
export function sha512Integrity(buffer: Uint8Array): string;
export function renderFormula(template: string, values: { version: string; sha256: string }): string;
export function fetchTarball(
  version: string,
  options?: { fetchImpl?: typeof fetch; retries?: number; delayMs?: number; log?: (line: string) => void },
): Promise<Buffer>;
