import { sha256Hex } from '../sha256';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export interface MediaFile {
  /** Base64 payload. */
  data: string;
  mimeType: string;
}

/**
 * Where binary content goes. Rendering never prints binary data: it asks the sink to store it
 * and prints the returned path (output.md, step 5).
 */
export interface MediaSink {
  save(media: MediaFile): string;
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'text/plain': 'txt',
};

export function extensionFor(mimeType: string): string {
  const base = mimeType.split(';')[0]!.trim().toLowerCase();
  return EXTENSIONS[base] ?? (/^[a-z0-9]+\/(?:x-)?([a-z0-9]+)$/.exec(base)?.[1] ?? 'bin');
}

/** Writes media files into a private (0700) directory, named by content hash. */
export class FileMediaSink implements MediaSink {
  constructor(private readonly dir: string) {}

  save(media: MediaFile): string {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // best effort
    }
    const hash = sha256Hex(media.data).slice(0, 12);
    const path = join(this.dir, `${hash}.${extensionFor(media.mimeType)}`);
    writeFileSync(path, Buffer.from(media.data, 'base64'), { mode: 0o600 });
    return path;
  }
}

/** Sink that records requests instead of writing files; for tests and dry runs. */
export class MemoryMediaSink implements MediaSink {
  readonly saved: MediaFile[] = [];

  constructor(private readonly dir = '/cache/media') {}

  save(media: MediaFile): string {
    this.saved.push(media);
    const hash = sha256Hex(media.data).slice(0, 12);
    return `${this.dir}/${hash}.${extensionFor(media.mimeType)}`;
  }
}
