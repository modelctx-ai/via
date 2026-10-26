import { describe, expect, it } from 'vitest';
import { renderStatus } from '../../src/cli/commands/daemon';
import type { DaemonStatus } from '../../src/protocol';

const base: DaemonStatus = {
  pid: 4242,
  version: '0.4.0',
  socket: '/run/via/daemon.sock',
  startedAt: 0,
  uptimeMs: 65_000,
  idleTimeoutMs: 0,
  requests: 3,
  cursors: 0,
  rssBytes: 83 * 1024 * 1024,
  sessions: [],
};

describe('daemon status memory', () => {
  it('names both figures: rss and the anonymous part', () => {
    const text = renderStatus({ ...base, anonBytes: 41.2 * 1024 * 1024 });
    expect(text.split('\n')[0]).toBe('daemon: running · pid 4242 · v0.4.0 · up 1m05s · rss 83.0 MB · anon 41.2 MB · busy');
  });

  it('writes n/a where the platform has no such figure', () => {
    expect(renderStatus({ ...base, anonBytes: null })).toContain(' · rss 83.0 MB · anon n/a · ');
  });

  it('shows only rss for a daemon of an older version that does not report it', () => {
    const head = renderStatus(base).split('\n')[0]!;
    expect(head).toContain(' · rss 83.0 MB · ');
    expect(head).not.toContain('anon');
  });
});
