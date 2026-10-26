import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateLayer } from '../../src/config/layer';
import { loadPolicy } from '../../src/config/load';
import { emptyPolicy, isInternalCommand, isVisible, mergePolicy, refusedBy } from '../../src/config/policy';
import { policyFiles } from '../../src/config/policy-probe';
import { pathContext } from '../../src/config/paths';
import { makeTree } from '../helpers/config';

const ctx = pathContext({ home: '/home/u', env: {}, platform: 'linux' });

function layer(raw: unknown, scope: 'user' | 'project' | 'cli' = 'user', path = '/home/u/.config/via/config.yaml') {
  const { data, diagnostics } = validateLayer(raw, path);
  return { layer: { origin: scope === 'cli' ? { scope } : { scope, path }, data }, diagnostics };
}

describe('commands: validation', () => {
  it('names are compared like the command line compares them', () => {
    const { layer: l, diagnostics } = layer({ commands: { deny: ['Serve', 'daemon'], allow: ['find', 'CALL'], hide: ['DOCTOR'], show: ['find'] } });
    expect(diagnostics).toEqual([]);
    expect(l.data.commands).toEqual({ deny: ['serve', 'daemon'], allow: ['find', 'call'], hide: ['doctor'], show: ['find'] });
  });

  it('an unknown name is an error where dropping it would leave a command runnable or shown, a warning elsewhere', () => {
    const { diagnostics } = layer({ commands: { deny: ['sevre'], hide: ['nope'], allow: ['fnd'], show: ['x'] }, sandbox: { exclude: ['zzz'] } });
    expect(diagnostics.map((d) => [d.level, d.code, d.message.split(':')[0]])).toEqual([
      ['error', 'unknown-command', 'commands.deny[0]'],
      ['error', 'unknown-command', 'commands.hide[0]'],
      ['warning', 'unknown-command', 'commands.allow[0]'],
      ['warning', 'unknown-command', 'commands.show[0]'],
      ['warning', 'unknown-command', 'sandbox.exclude[0]'],
    ]);
  });

  it('help cannot be restricted', () => {
    const { layer: l, diagnostics } = layer({ commands: { deny: ['help', 'serve'] } });
    expect(l.data.commands.deny).toEqual(['serve']);
    expect(diagnostics).toMatchObject([{ level: 'warning', message: 'commands.deny[0]: help cannot be restricted; ignored' }]);
  });

  it('wrong shapes are field errors', () => {
    const { diagnostics } = layer({ commands: ['serve'], sandbox: { enabled: 'yes', command: [], policy: 3, other: 1 } });
    expect(diagnostics.map((d) => d.message)).toEqual([
      'commands: expected map with allow, deny, hide or show',
      'sandbox.enabled: expected boolean',
      'sandbox.command: expected a program name, or a non-empty list of words',
      'sandbox.policy: expected map (the sandbox settings) or the path of a JSON file with them',
      'sandbox.other: unknown field',
    ]);
  });
});

describe('commands: merging and decisions', () => {
  it('deny and hide add up, allow and show narrow: a project can only take commands away', () => {
    const user = layer({ commands: { allow: ['find', 'call', 'more', 'serve'], hide: ['more'] } }).layer;
    const project = layer({ commands: { allow: ['find', 'call', 'trust'], deny: ['call'] } }, 'project', '/repo/.via.yaml').layer;
    const { policy } = mergePolicy([user, project], ctx, '/repo');
    expect([...policy.commands.allow!]).toEqual(['find', 'call']);
    expect(refusedBy(policy.commands, 'find')).toBeUndefined();
    expect(refusedBy(policy.commands, 'call')).toBe('deny');
    expect(refusedBy(policy.commands, 'trust')).toBe('allow');
    expect(refusedBy(policy.commands, 'serve')).toBe('allow');
    expect(refusedBy(policy.commands, 'help')).toBeUndefined();
    expect(isVisible(policy.commands, 'find')).toBe(true);
    expect(isVisible(policy.commands, 'call')).toBe(false);
  });

  it('hidden is still runnable; show lists the only ones shown', () => {
    const { policy } = mergePolicy([layer({ commands: { hide: ['daemon'], show: ['find', 'daemon', 'more'] } }).layer], ctx, '/');
    expect(refusedBy(policy.commands, 'daemon')).toBeUndefined();
    expect(isVisible(policy.commands, 'daemon')).toBe(false);
    expect(isVisible(policy.commands, 'more')).toBe(true);
    expect(isVisible(policy.commands, 'call')).toBe(false);
  });

  it('daemon run is how via starts its daemon', () => {
    expect(isInternalCommand('daemon', ['run', '--socket', 'x'])).toBe(true);
    expect(isInternalCommand('daemon', ['stop'])).toBe(false);
  });
});

describe('sandbox: merging', () => {
  it('is off by default and runs auth, trust and daemon outside', () => {
    expect(emptyPolicy().sandbox).toEqual({ enabled: false, command: ['srt'], exclude: ['auth', 'trust', 'daemon'] });
  });

  it('the user config turns it on; a policy path is relative to the file that names it', () => {
    const { policy } = mergePolicy([layer({ sandbox: { enabled: true, command: ['srt', '--debug'], policy: 'srt.json', exclude: ['auth'] } }).layer], ctx, '/repo');
    expect(policy.sandbox).toMatchObject({ enabled: true, command: ['srt', '--debug'], policy: { file: resolve('/home/u/.config/via', 'srt.json') }, exclude: ['auth'] });
    const inline = mergePolicy([layer({ sandbox: { enabled: true, command: 'my-srt', policy: { network: { allowedDomains: ['a.example'] } } } }).layer], ctx, '/repo').policy.sandbox;
    expect(inline).toMatchObject({ command: ['my-srt'], policy: { inline: { network: { allowedDomains: ['a.example'] } } } });
  });

  it('a project config cannot touch it', () => {
    const user = layer({ sandbox: { enabled: true } }).layer;
    const project = layer({ sandbox: { enabled: false, policy: { network: { allowedDomains: ['*'] } } } }, 'project', '/repo/.via.yaml').layer;
    const { policy, diagnostics } = mergePolicy([user, project], ctx, '/repo');
    expect(policy.sandbox.enabled).toBe(true);
    expect(policy.sandbox.policy).toBeUndefined();
    expect(diagnostics).toMatchObject([{ level: 'warning', code: 'sandbox-forbidden', file: '/repo/.via.yaml' }]);
  });

  it('the command line overrides the user config', () => {
    const { policy } = mergePolicy([layer({ sandbox: { enabled: true } }).layer, layer({ sandbox: { enabled: false } }, 'cli').layer], ctx, '/');
    expect(policy.sandbox.enabled).toBe(false);
  });
});

describe('loadPolicy', () => {
  it('finds the files that mention either key and reads only those fields', async () => {
    const tree = makeTree({
      'home/.config/via/config.yaml': 'servers:\n  x:\n    timeout: nope\ncommands:\n  deny: [serve]\n',
      'repo/.via.yaml': 'commands: { hide: [daemon] }\n',
    });
    const home = join(tree.root, 'home');
    const cwd = join(tree.root, 'repo');
    const files = policyFiles(pathContext({ home, env: {}, platform: 'linux' }), cwd);
    expect(files).toHaveLength(2);
    const { policy, diagnostics } = await loadPolicy(files, { home, cwd, env: {}, platform: 'linux' });
    expect([...policy.commands.deny]).toEqual(['serve']);
    expect([...policy.commands.hide]).toEqual(['daemon']);
    // `servers.x.timeout` is loadConfig's to report.
    expect(diagnostics).toEqual([]);
  });

  it('a config that does not mention them is not parsed at all', () => {
    const tree = makeTree({ 'home/.config/via/config.yaml': 'servers: {}\n' });
    expect(policyFiles(pathContext({ home: join(tree.root, 'home'), env: {}, platform: 'linux' }), tree.root)).toEqual([]);
  });

  it('a file that mentions them but cannot be parsed is an error: the command must not run without its deny', async () => {
    const tree = makeTree({ 'home/.config/via/config.yaml': 'commands:\n  deny: [serve\n' });
    const home = join(tree.root, 'home');
    const { diagnostics } = await loadPolicy(policyFiles(pathContext({ home, env: {}, platform: 'linux' }), tree.root), { home, cwd: tree.root, env: {}, platform: 'linux' });
    expect(diagnostics).toMatchObject([{ level: 'error', code: 'file-malformed' }]);
  });
});
