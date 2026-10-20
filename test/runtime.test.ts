import { describe, expect, it } from 'vitest';
import { importKeyring } from '../src/keyring';
import { isCompiledBinary, selfCommand } from '../src/runtime';

describe('runtime detection', () => {
  it('recognises the entry path of a Bun single-file executable', () => {
    expect(isCompiledBinary('/$bunfs/root/via-linux-x64', '1.4.2')).toBe(true);
    expect(isCompiledBinary('B:\\~BUN\\root\\via-windows-x64.exe', '1.4.2')).toBe(true);
    expect(isCompiledBinary('B:/~BUN/root/via.exe', '1.4.2')).toBe(true);
  });

  it('does not mistake a script for it, under Node or under Bun', () => {
    expect(isCompiledBinary('/usr/lib/node_modules/@modelctx/via/dist/via.js', undefined)).toBe(false);
    expect(isCompiledBinary('/home/me/via/dist/via.js', '1.4.2')).toBe(false);
    expect(isCompiledBinary('/$bunfs/root/via', undefined)).toBe(false);
    expect(isCompiledBinary(undefined, '1.4.2')).toBe(false);
  });

  it('starts the daemon as runtime + script, or as the executable alone', () => {
    expect(selfCommand('/usr/bin/node', '/opt/via/dist/via.js', undefined)).toEqual({ command: '/usr/bin/node', args: ['/opt/via/dist/via.js'] });
    expect(selfCommand('/usr/local/bin/bun', '/opt/via/dist/via.js', '1.4.2')).toEqual({ command: '/usr/local/bin/bun', args: ['/opt/via/dist/via.js'] });
    expect(selfCommand('/usr/local/bin/via', '/$bunfs/root/via-linux-x64', '1.4.2')).toEqual({ command: '/usr/local/bin/via', args: [] });
  });
});

describe('importKeyring', () => {
  const where = `${process.platform}-${process.arch}`;

  it('turns the stock napi-rs load failure into one line that does not talk about npm', async () => {
    const load = () => Promise.reject(new Error('Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828).\nPlease try `npm i` again'));
    await expect(importKeyring(load)).rejects.toThrow(new Error(`the native keychain module is not available on ${where}`));
  });

  it('keeps the cause of other failures (a missing or bad .node file) on the first line', async () => {
    const load = () => Promise.reject(new Error("Cannot find module '/x/keyring.node'\nRequire stack: ..."));
    await expect(importKeyring(load)).rejects.toThrow(new Error(`the native keychain module is not available on ${where} (Cannot find module '/x/keyring.node')`));
  });

  it('returns the module when it loads', async () => {
    const module = { AsyncEntry: class {} };
    expect(await importKeyring(async () => module)).toBe(module);
  });
});
