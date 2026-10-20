// JSON Lines framing for the socket (daemon.md, "CLI 与 daemon 的协议"): one message per line.
// Shared by the daemon and the CLI client; keep it free of heavy imports.

/** A single message larger than this closes the connection (a tool result is the biggest thing sent). */
export const MAX_LINE_BYTES = 256 * 1024 * 1024;

export function encode(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/** Splits a byte stream into lines without decoding half a UTF-8 character. */
export class LineDecoder {
  private chunks: Buffer[] = [];
  private size = 0;

  /** Feed a chunk; returns the complete lines it finished. Throws when a line exceeds `MAX_LINE_BYTES`. */
  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      if (nl < 0) break;
      this.chunks.push(chunk.subarray(start, nl));
      lines.push(Buffer.concat(this.chunks).toString('utf8'));
      this.chunks = [];
      this.size = 0;
      start = nl + 1;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this.chunks.push(rest);
      this.size += rest.length;
      if (this.size > MAX_LINE_BYTES) throw new RangeError('message too large');
    }
    return lines.filter((l) => l !== '');
  }
}

/** Parse one line; undefined when it is not a JSON object. */
export function parseMessage(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
