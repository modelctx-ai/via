import { describe, expect, it } from 'vitest';
import { RESERVED_COMMANDS } from '../../src/catalog';
import { ACTIVE_COMMANDS, ALL_COMMANDS, FUTURE_COMMANDS, matchBuiltin } from '../../src/cli/builtins';
import { CliFailure } from '../../src/cli/failure';
import { extractGlobals, parseLocal } from '../../src/cli/options';

describe('extractGlobals', () => {
  it('defaults', () => {
    expect(extractGlobals([])).toEqual({
      options: { format: 'text', full: false, all: false, yes: false, dryRun: false, noValidate: false, help: false },
      rest: [],
    });
  });

  it('takes every global option from any position and keeps the rest in order', () => {
    const { options, rest } = extractGlobals(['gh', '--yes', 'issue:list', '-o', 'json', '--owner', 'a', '--timeout', '2.5', '--full', '--all', '--dry-run', '--no-validate', '-h']);
    expect(options).toEqual({ format: 'json', full: true, all: true, yes: true, dryRun: true, noValidate: true, timeoutMs: 2500, help: true });
    expect(rest).toEqual(['gh', 'issue:list', '--owner', 'a']);
  });

  it('accepts -o=json and --timeout=5 and --help', () => {
    const { options } = extractGlobals(['-o=raw', '--timeout=5', '--help']);
    expect(options).toMatchObject({ format: 'raw', timeoutMs: 5000, help: true });
  });

  it('leaves --p.<name> for the tool, even when it is spelled like a global', () => {
    const { options, rest } = extractGlobals(['gh', 'x:y', '--p.full', 'a', '--p.yes', '--p.timeout', '5']);
    expect(options.full).toBe(false);
    expect(options.yes).toBe(false);
    expect(options.timeoutMs).toBeUndefined();
    expect(rest).toEqual(['gh', 'x:y', '--p.full', 'a', '--p.yes', '--p.timeout', '5']);
  });

  it('does not touch tool options that are not global', () => {
    expect(extractGlobals(['--args', '{"a":1}', '--no-draft', '-n', '3']).rest).toEqual(['--args', '{"a":1}', '--no-draft', '-n', '3']);
  });

  it.each([
    [['-o', 'yaml']],
    [['-o']],
    [['--timeout']],
    [['--timeout', '0']],
    [['--timeout', '-1']],
    [['--timeout=abc']],
  ])('rejects %j with a usage failure', (argv) => {
    try {
      extractGlobals(argv);
      throw new Error('did not throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CliFailure);
      expect((error as CliFailure).info.code).toBe(2);
    }
  });
});

describe('parseLocal', () => {
  const flags = [{ name: 'scope', value: true }, { name: 'limit', value: true, short: 'n' }, { name: 'quiet', value: false }];

  it('splits flags and positionals', () => {
    expect(parseLocal('find', ['create', '--scope', 'code', 'issue', '-n', '3', '--quiet'], flags)).toEqual({
      flags: { scope: 'code', limit: '3', quiet: true },
      positionals: ['create', 'issue'],
    });
    expect(parseLocal('find', ['--scope=code'], flags).flags).toEqual({ scope: 'code' });
  });

  it('rejects unknown flags and missing values', () => {
    expect(() => parseLocal('find', ['--nope'], flags)).toThrow(CliFailure);
    expect(() => parseLocal('find', ['--scope'], flags)).toThrow(CliFailure);
  });
});

describe('built-in names', () => {
  it('match the names the catalog reserves', () => {
    expect([...ALL_COMMANDS].sort()).toEqual([...RESERVED_COMMANDS].sort());
    expect([...ACTIVE_COMMANDS, ...FUTURE_COMMANDS, 'help'].sort()).toEqual([...RESERVED_COMMANDS].sort());
  });

  it('are matched leniently', () => {
    expect(matchBuiltin('FIND')).toBe('find');
    expect(matchBuiltin('github')).toBeUndefined();
    expect(matchBuiltin('fin')).toBeUndefined();
  });
});
