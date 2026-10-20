// Standard output and error without touching `process.stdout` / `process.stderr`.
//
// Node builds those streams lazily on first access, and for a pipe or a terminal that pulls in
// `net`, `tty`, `stream` and friends: about 10 ms of a cold start that prints a few lines
// (implementation.md, "启动速度"). A browse command writes once or twice and exits, so a
// synchronous `write(2)` on the file descriptor does the same job. Pipes and files are written
// synchronously by Node on POSIX as well, so ordering and back-pressure behave the same.
//
// Windows keeps the real streams: console handles there do not take plain `write(2)` reliably.
import { writeSync } from 'node:fs';

export interface Writer {
  write(chunk: string): unknown;
}

type Fallback = () => Writer;

/** Sleep for about a millisecond without spinning, to retry a full non-blocking pipe. */
function pause(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}

/**
 * A writer for file descriptor `fd` (1 or 2). Output that cannot be delivered because the reader
 * went away (EPIPE, `via | head`) is dropped, like a closed stdout; any other failure is retried
 * through `fallback` (the real stream) so it surfaces the usual way.
 */
export function fdWriter(fd: 1 | 2, fallback: Fallback, platform: NodeJS.Platform = process.platform): Writer {
  if (platform === 'win32') return { write: (chunk) => fallback().write(chunk) };
  return {
    write(chunk: string): boolean {
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
          if (code === 'EPIPE' || code === 'EBADF') return false;
          return fallback().write(Buffer.from(bytes.subarray(offset)).toString('utf8')) as boolean;
        }
      }
      return true;
    },
  };
}

export const stdoutWriter = (): Writer => fdWriter(1, () => process.stdout);
export const stderrWriter = (): Writer => fdWriter(2, () => process.stderr);
