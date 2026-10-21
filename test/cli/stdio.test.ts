import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fdWriter } from '../../src/cli/stdio';

// A file opened here stands in for stdout. The platform and the console probe are injected, so the
// Windows rules run on every host.
describe('fdWriter', () => {
  const noStream = () => {
    throw new Error('the real stream was used');
  };

  function written(run: (fd: number) => void): string {
    const dir = mkdtempSync(join(tmpdir(), 'via-stdio-'));
    const path = join(dir, 'out.txt');
    const fd = openSync(path, 'w');
    try {
      run(fd);
    } finally {
      closeSync(fd);
    }
    const text = readFileSync(path, 'utf8');
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    return text;
  }

  it('writes straight to the descriptor on POSIX without touching the stream', () => {
    expect(written((fd) => fdWriter(fd, noStream, 'linux').write('héllo\n'))).toBe('héllo\n');
  });

  it('writes a pipe or a file directly on Windows too, so net and stream stay unloaded', () => {
    // The probe sees something that is not a character device.
    expect(written((fd) => fdWriter(fd, noStream, 'win32', () => false).write('héllo\n'))).toBe('héllo\n');
  });

  it('keeps the real stream for a Windows console and asks the probe once', () => {
    const chunks: string[] = [];
    let probes = 0;
    const writer = fdWriter(1, () => ({ write: (c: string) => chunks.push(c) }), 'win32', () => {
      probes += 1;
      return true;
    });
    writer.write('a');
    writer.write('b');
    expect(chunks).toEqual(['a', 'b']);
    expect(probes).toBe(1);
  });

  it('does not probe the descriptor before the first write', () => {
    let probes = 0;
    fdWriter(1, noStream, 'win32', () => {
      probes += 1;
      return true;
    });
    expect(probes).toBe(0);
  });
});
