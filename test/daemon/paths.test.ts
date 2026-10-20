// Where the daemon lives, per platform (daemon.md, "生命周期", "socket 安全"). Windows is injected.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathContext } from '../../src/config/paths';
import { daemonPaths, describeEndpoint, endpointOf } from '../../src/daemon/paths';

const win = (env: Record<string, string> = {}, socket?: string) =>
  daemonPaths(pathContext({ home: 'C:\\Users\\Me', env: { LOCALAPPDATA: 'D:\\Local', USERNAME: 'Me', ...env }, platform: 'win32' }), socket);

describe('daemonPaths', () => {
  it('on Windows: a derived pipe, with the token, lock and log in the user cache directory', () => {
    expect(win()).toEqual({
      dir: 'D:\\Local\\via\\Cache',
      socket: '\\\\.\\pipe\\via-Me',
      lock: 'D:\\Local\\via\\Cache\\via.lock',
      token: 'D:\\Local\\via\\Cache\\via.token',
      log: 'D:\\Local\\via\\Cache\\via-daemon.log',
      pipe: true,
      derived: true,
    });
  });

  it('keeps characters that cannot be in a pipe name out of it', () => {
    expect(win({ USERNAME: 'DOMAIN\\Me Too' }).socket).toBe('\\\\.\\pipe\\via-DOMAIN_Me_Too');
    expect(win({ USERNAME: '张三' }).socket).toBe('\\\\.\\pipe\\via-__');
    expect(win({ USERNAME: 'x'.repeat(100) }).socket).toBe(`\\\\.\\pipe\\via-${'x'.repeat(40)}`);
    const lower = daemonPaths(pathContext({ home: 'C:\\Users\\Me', env: { username: 'lower' }, platform: 'win32' }));
    expect(lower.socket).toBe('\\\\.\\pipe\\via-lower');
  });

  it('on Windows with --socket: that exact pipe, with files named after it', () => {
    const paths = win({}, '\\\\.\\pipe\\via-test 1');
    expect(paths).toMatchObject({ socket: '\\\\.\\pipe\\via-test 1', pipe: true, derived: false });
    expect(paths.token).toBe('D:\\Local\\via\\Cache\\via-test_1.token');
    expect(paths.lock).toBe('D:\\Local\\via\\Cache\\via-test_1.lock');
    expect(paths.log).toBe('D:\\Local\\via\\Cache\\via-test_1.log');
  });

  it('on POSIX: a socket file with its companions beside it, never derived', () => {
    const runtime = join('/run', 'user', '1000');
    const linux = daemonPaths(pathContext({ home: '/home/me', env: { XDG_RUNTIME_DIR: runtime }, platform: 'linux' }));
    expect(linux).toMatchObject({ socket: join(runtime, 'via.sock'), token: `${join(runtime, 'via.sock')}.token`, pipe: false, derived: false });
    const mac = daemonPaths(pathContext({ home: '/Users/me', env: {}, platform: 'darwin' }));
    expect(mac.socket).toBe(join('/Users/me', 'Library', 'Caches', 'via', 'via.sock'));
  });
});

describe('endpointOf', () => {
  const paths = win();
  const token = 'a'.repeat(64);

  it('names a derived pipe after the token: 128 bits of a digest, stable for one token', () => {
    const endpoint = endpointOf(paths, token);
    expect(endpoint).toMatch(/^\\\\\.\\pipe\\via-Me-[0-9a-f]{32}$/);
    expect(endpointOf(paths, token)).toBe(endpoint);
    expect(endpointOf(paths, 'b'.repeat(64))).not.toBe(endpoint);
    expect(endpoint).not.toContain(token.slice(0, 16)); // a digest, not the token
  });

  it('has no endpoint without a token: no token file means no daemon', () => {
    expect(endpointOf(paths, undefined)).toBeUndefined();
    expect(endpointOf(paths, '')).toBeUndefined();
  });

  it('is the socket itself when the name is fixed', () => {
    expect(endpointOf(win({}, '\\\\.\\pipe\\x'), token)).toBe('\\\\.\\pipe\\x');
    expect(endpointOf(win({}, '\\\\.\\pipe\\x'), undefined)).toBe('\\\\.\\pipe\\x');
    const posix = daemonPaths(pathContext({ home: '/h', env: { XDG_RUNTIME_DIR: '/run/u' }, platform: 'linux' }));
    expect(endpointOf(posix, undefined)).toBe(posix.socket);
  });

  it('shows the digest as * where no daemon is running', () => {
    expect(describeEndpoint(paths)).toBe('\\\\.\\pipe\\via-Me-*');
    expect(describeEndpoint(win({}, '\\\\.\\pipe\\x'))).toBe('\\\\.\\pipe\\x');
  });
});
