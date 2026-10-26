// Host detection for `via doctor` (src/platform/host.ts): everything is injected, so the tests
// are the same on every host.
import { describe, expect, it } from 'vitest';
import { detectHost, windowsSidePaths } from '../../src/platform/host';

describe('detectHost', () => {
  it('is windows on win32 whatever the environment says', () => {
    expect(detectHost({ platform: 'win32', env: {} })).toBe('windows');
    expect(detectHost({ platform: 'win32', env: { WSL_DISTRO_NAME: 'Ubuntu' } })).toBe('windows');
  });

  it('is wsl on linux when WSL set its variables or the kernel banner names microsoft', () => {
    expect(detectHost({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' } })).toBe('wsl');
    expect(detectHost({ platform: 'linux', env: { WSL_INTEROP: '/run/WSL/8_interop' } })).toBe('wsl');
    const banner = 'Linux version 5.15.167.4-microsoft-standard-WSL2 (root@...) #1 SMP';
    expect(detectHost({ platform: 'linux', env: {}, readProcVersion: () => banner })).toBe('wsl');
  });

  it('is other on plain linux, on macOS, and when /proc/version cannot be read', () => {
    expect(detectHost({ platform: 'linux', env: {}, readProcVersion: () => 'Linux version 6.8.0-45-generic (buildd@lcy02) ...' })).toBe('other');
    expect(detectHost({ platform: 'linux', env: {}, readProcVersion: () => undefined })).toBe('other');
    expect(detectHost({ platform: 'linux', env: {} })).toBe('other');
    expect(detectHost({ platform: 'darwin', env: { WSL_DISTRO_NAME: 'x' }, readProcVersion: () => 'microsoft' })).toBe('other');
  });
});

describe('windowsSidePaths', () => {
  it('keeps the paths under a drive mount, once each, in order, and skips undefined', () => {
    const paths = [
      '/home/u/.config/via/config.yaml',
      '/mnt/c/Users/u/AppData/Roaming/Claude/claude_desktop_config.json',
      undefined,
      '/mnt/d/work/repo/.mcp.json',
      '/mnt/c/Users/u/AppData/Roaming/Claude/claude_desktop_config.json',
      '/mnt/cdrom/not-a-drive.json',
      '/mnt/C/Users/u/.cursor/mcp.json',
    ];
    expect(windowsSidePaths(paths)).toEqual([
      '/mnt/c/Users/u/AppData/Roaming/Claude/claude_desktop_config.json',
      '/mnt/d/work/repo/.mcp.json',
      '/mnt/C/Users/u/.cursor/mcp.json',
    ]);
    expect(windowsSidePaths([])).toEqual([]);
  });
});
