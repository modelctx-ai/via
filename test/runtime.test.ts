import { describe, expect, it } from 'vitest';
import { importKeyring } from '../src/keyring';
import { selfCommand } from '../src/runtime';

describe('selfCommand', () => {
  it('starts the daemon as runtime + script', () => {
    expect(selfCommand('/usr/bin/node', '/opt/via/dist/via.js')).toEqual({ command: '/usr/bin/node', args: ['/opt/via/dist/via.js'] });
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
