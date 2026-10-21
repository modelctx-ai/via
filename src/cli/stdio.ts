// Standard output and error without touching `process.stdout` / `process.stderr`.
//
// Node builds those streams lazily on first access, and for a pipe or a terminal that pulls in
// `net`, `tty`, `stream` and friends: about 10 ms of a cold start that prints a few lines
// (implementation.md, "启动速度"). A browse command writes once or twice and exits, so a
// synchronous `write(2)` on the file descriptor does the same job. Pipes and files are written
// synchronously by Node on POSIX as well, so ordering and back-pressure behave the same.
//
// Windows keeps the real streams for a console only: console handles there do not take plain
// `write(2)` reliably (the code page decides the encoding; the stream writes UTF-16). A pipe or a
// file is written the same way as on POSIX, so `via --version | ...` still loads neither `net` nor
// `stream`.
import { fstatSync, writeSync } from 'node:fs';

export interface Writer {
  write(chunk: string): unknown;
}

type Fallback = () => Writer;

/** Sleep for about a millisecond without spinning, to retry a full non-blocking pipe. */
function pause(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}

/** A console (or the NUL device) reports as a character device; a pipe or a file does not. */
function isCharacterDevice(fd: number): boolean {
  try {
    return fstatSync(fd).isCharacterDevice();
  } catch {
    // An unusable descriptor is left to the real stream to report.
    return true;
  }
}

/**
 * A writer for file descriptor `fd` (1 or 2). Output that cannot be delivered because the reader
 * went away (EPIPE, `via | head`) is dropped, like a closed stdout; any other failure is retried
 * through `fallback` (the real stream) so it surfaces the usual way.
 */
export function fdWriter(
  fd: number,
  fallback: Fallback,
  platform: NodeJS.Platform = process.platform,
  characterDevice: (fd: number) => boolean = isCharacterDevice,
): Writer {
  // Decided on the first write (one fstat), not when the writer is made.
  let useStream: boolean | undefined;
  return {
    write(chunk: string): boolean {
      useStream ??= platform === 'win32' && characterDevice(fd);
      if (useStream) return fallback().write(chunk) as boolean;
      const bytes = Buffer.from(chunk, 'utf8');
      let offset = 0;
      let waited = 0;
      while (offset < bytes.length) {
        try {
          offset += writeSync(fd, bytes, offset, bytes.length - offset);
          waited = 0;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EAGAIN' && waited < 30_000) {
            // The descriptor is non-blocking and the pipe is full: wait for the reader.
            pause();
            waited += 1;
            continue;
          }
          if (code === 'EPIPE' || code === 'EBADF' || code === 'EOF') return false;
          return fallback().write(Buffer.from(bytes.subarray(offset)).toString('utf8')) as boolean;
        }
      }
      return true;
    },
  };
}

export const stdoutWriter = (): Writer => fdWriter(1, () => process.stdout);
export const stderrWriter = (): Writer => fdWriter(2, () => process.stderr);
