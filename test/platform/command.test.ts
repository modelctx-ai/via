// Starting programs on Windows (src/platform/command.ts). Everything runs with an injected
// `platform: 'win32'` and a fake file system, so it is the same on every host.
import { describe, expect, it } from 'vitest';
import {
  batchArgumentProblem,
  commandInterpreter,
  executableExtensions,
  planSpawn,
  prepareStdioCommand,
  programKind,
  quoteForCmd,
  resolveWindowsProgram,
  searchDirectories,
  type ResolveOptions,
} from '../../src/platform/command';

const SYSTEM = 'C:\\Windows\\System32\\cmd.exe';

/** A machine with these files and this environment; the working directory is a repository. */
function machine(files: string[], env: Record<string, string> = {}, cwd = 'C:\\repo'): ResolveOptions {
  const known = new Set(files.map((f) => f.toLowerCase()));
  return {
    env: { Path: 'C:\\Program Files\\nodejs;C:\\Tools;', PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: 'C:\\Windows', ...env },
    cwd,
    platform: 'win32',
    isFile: (path) => known.has(path.toLowerCase()),
  };
}

describe('PATH and PATHEXT', () => {
  it('reads PATHEXT, with the Windows default', () => {
    expect(executableExtensions({ PATHEXT: '.EXE; .CMD ;;.JS;nonsense' })).toEqual(['.exe', '.cmd', '.js']);
    expect(executableExtensions({})).toEqual(['.com', '.exe', '.bat', '.cmd']);
    expect(executableExtensions({ pathext: '.EXE' }, 'win32')).toEqual(['.exe']);
  });

  it('keeps absolute PATH entries only, without their quotes, whatever the case of the variable name', () => {
    expect(searchDirectories({ PATH: '"C:\\Program Files\\x";C:\\a;;.;..\\up;tools' })).toEqual(['C:\\Program Files\\x', 'C:\\a']);
    expect(searchDirectories({ Path: 'C:\\a' }, 'win32')).toEqual(['C:\\a']);
    expect(searchDirectories({})).toEqual([]);
  });

  it('classifies what it can start', () => {
    expect(programKind('C:\\x\\a.EXE')).toBe('exe');
    expect(programKind('a.com')).toBe('exe');
    expect(programKind('C:\\x\\npx.cmd')).toBe('batch');
    expect(programKind('a.BAT')).toBe('batch');
    expect(programKind('a.ps1')).toBe('other');
    expect(programKind('C:\\dir.d\\a')).toBe('other');
  });
});

describe('resolveWindowsProgram', () => {
  it('finds npx.cmd for "npx" through PATHEXT, in PATH order', () => {
    const m = machine(['C:\\Program Files\\nodejs\\npx.cmd', 'C:\\Tools\\npx.exe']);
    expect(resolveWindowsProgram('npx', m)).toBe('C:\\Program Files\\nodejs\\npx.cmd');
  });

  it('tries the extensions in PATHEXT order inside one directory', () => {
    const m = machine(['C:\\Tools\\op.cmd', 'C:\\Tools\\op.exe']);
    expect(resolveWindowsProgram('op', m)).toBe('C:\\Tools\\op.exe');
    expect(resolveWindowsProgram('op', machine(['C:\\Tools\\op.cmd', 'C:\\Tools\\op.exe'], { PATHEXT: '.CMD;.EXE' }))).toBe('C:\\Tools\\op.cmd');
  });

  it('uses a name that already has an executable extension as is, in any case', () => {
    const m = machine(['C:\\Tools\\Node.exe']);
    expect(resolveWindowsProgram('node.EXE', m)).toBe('C:\\Tools\\node.EXE');
    expect(resolveWindowsProgram('node.exe', machine(['C:\\Tools\\node.exe.exe']))).toBeUndefined();
  });

  it('appends the extensions to a name with a dot that is not one of them', () => {
    expect(resolveWindowsProgram('python3.11', machine(['C:\\Tools\\python3.11.exe']))).toBe('C:\\Tools\\python3.11.exe');
  });

  it('never looks in the working directory for a bare name', () => {
    const m = machine(['C:\\repo\\npx.cmd', 'C:\\repo\\node.exe', 'C:\\repo\\tool.exe']);
    expect(resolveWindowsProgram('npx', m)).toBeUndefined();
    expect(resolveWindowsProgram('node', m)).toBeUndefined();
    // Not even when PATH names the current directory in a relative way.
    expect(resolveWindowsProgram('tool', machine(['C:\\repo\\tool.exe'], { Path: '.;;C:\\Tools' }))).toBeUndefined();
  });

  it('resolves an explicit path against the working directory, and only there', () => {
    const m = machine(['C:\\repo\\tools\\op.exe', 'C:\\Tools\\op.exe']);
    expect(resolveWindowsProgram('.\\tools\\op', m)).toBe('C:\\repo\\tools\\op.exe');
    expect(resolveWindowsProgram('tools/op.exe', m)).toBe('C:\\repo\\tools\\op.exe');
    expect(resolveWindowsProgram('C:\\Tools\\op', m)).toBe('C:\\Tools\\op.exe');
    expect(resolveWindowsProgram('D:\\nowhere\\op', m)).toBeUndefined();
    expect(resolveWindowsProgram('..\\op', m)).toBeUndefined();
  });

  it('returns nothing for names that cannot be programs', () => {
    const m = machine(['C:\\Tools\\a.exe']);
    for (const name of ['', 'a|b', 'a"b', 'a*', 'a\0b', '<a>']) expect(resolveWindowsProgram(name, m)).toBeUndefined();
  });
});

describe('quoting for cmd.exe', () => {
  it('wraps a word in double quotes and doubles a trailing run of backslashes', () => {
    expect(quoteForCmd('read')).toBe('"read"');
    expect(quoteForCmd('a b & c | d ^ e')).toBe('"a b & c | d ^ e"');
    expect(quoteForCmd('C:\\dir\\')).toBe('"C:\\dir\\\\"');
    expect(quoteForCmd('C:\\a\\b')).toBe('"C:\\a\\b"');
    expect(quoteForCmd('')).toBe('""');
  });

  it('refuses what cannot be quoted: double quotes, percent signs, line breaks, NUL', () => {
    expect(batchArgumentProblem(['read', 'op://vault/item/field', '--flag=a&b', '(x)', 'a^b', "it's", '!x!'])).toBeUndefined();
    expect(batchArgumentProblem(['ok', 'say "hi"'])).toContain('argument 2 contains a double quote');
    expect(batchArgumentProblem(['%PATH%'])).toContain('argument 1 contains "%"');
    expect(batchArgumentProblem(['a\nb'])).toContain('line break');
    expect(batchArgumentProblem(['a\rb'])).toContain('line break');
    expect(batchArgumentProblem(['a\0b'])).toContain('NUL');
  });

  it('never repeats the argument in the explanation', () => {
    expect(batchArgumentProblem(['secret-value-"-123'])).not.toContain('secret-value');
    expect(batchArgumentProblem(['secret-%PATH%'])).not.toContain('secret');
  });
});

describe('commandInterpreter', () => {
  it('takes ComSpec when it is a cmd.exe, else the one under SystemRoot', () => {
    expect(commandInterpreter({ ComSpec: 'D:\\Win\\system32\\CMD.EXE' })).toBe('D:\\Win\\system32\\CMD.EXE');
    expect(commandInterpreter({ ComSpec: 'C:\\evil\\powershell.exe', SystemRoot: 'C:\\Windows' })).toBe(SYSTEM);
    expect(commandInterpreter({ ComSpec: 'cmd.exe', SystemRoot: 'C:\\Windows' })).toBe(SYSTEM);
    expect(commandInterpreter({ windir: 'C:\\Windows' }, 'win32')).toBe(SYSTEM);
    expect(commandInterpreter({})).toBe('cmd.exe');
  });
});

describe('planSpawn', () => {
  it('starts an .exe directly, by its full path and with the arguments as they are', () => {
    const m = machine(['C:\\Tools\\op.exe']);
    const planned = planSpawn('op', ['read', 'op://a b/c', 'say "hi"', '%X%'], m);
    expect(planned).toEqual({
      ok: true,
      plan: { command: 'C:\\Tools\\op.exe', args: ['read', 'op://a b/c', 'say "hi"', '%X%'], windowsVerbatimArguments: false, resolved: 'C:\\Tools\\op.exe' },
    });
  });

  it('runs a .cmd shim through cmd.exe with every word quoted and the whole line in one more pair of quotes', () => {
    const m = machine(['C:\\Program Files\\nodejs\\npx.cmd']);
    const planned = planSpawn('npx', ['-y', '@scope/server@latest', '--root', 'C:\\My Files\\', 'a&b'], m);
    expect(planned).toEqual({
      ok: true,
      plan: {
        command: SYSTEM,
        args: ['/d', '/v:off', '/s', '/c', '""C:\\Program Files\\nodejs\\npx.cmd" "-y" "@scope/server@latest" "--root" "C:\\My Files\\\\" "a&b""'],
        windowsVerbatimArguments: true,
        resolved: 'C:\\Program Files\\nodejs\\npx.cmd',
      },
    });
  });

  it('turns metacharacters in a shim argument into literal text because they stay inside quotes', () => {
    const m = machine(['C:\\Tools\\az.bat']);
    const planned = planSpawn('az', ['x & calc.exe', '| whoami', '> out', '^ (y)'], m);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const line = planned.plan.args[4]!;
    // Every word is a complete quoted string; nothing sits outside quotes except the separating spaces.
    expect(line).toBe('""C:\\Tools\\az.bat" "x & calc.exe" "| whoami" "> out" "^ (y)""');
    expect(line.slice(1, -1).replace(/"[^"]*"/g, '').trim()).toBe('');
  });

  it('refuses a shim call it cannot make safe, saying what is wrong and not what the argument was', () => {
    const m = machine(['C:\\Tools\\az.cmd']);
    for (const bad of ['a"&calc&"b', '%COMSPEC%', 'a\nb']) {
      const planned = planSpawn('az', ['ok', bad], m);
      expect(planned).toMatchObject({ ok: false, reason: 'unsafe' });
      if (!planned.ok) expect(planned.message).not.toContain('calc');
    }
    // The same arguments are fine for a real executable: no shell reads them.
    expect(planSpawn('az', ['%COMSPEC%'], machine(['C:\\Tools\\az.exe'])).ok).toBe(true);
  });

  it('refuses a shim installed under a path cmd.exe cannot carry', () => {
    expect(planSpawn('tool', [], machine(['C:\\100%\\tool.cmd'], { Path: 'C:\\100%' }))).toMatchObject({ ok: false, reason: 'unsafe' });
  });

  it('reports a missing program and an unsupported one', () => {
    expect(planSpawn('nope', [], machine([]))).toEqual({ ok: false, reason: 'not-found', message: 'was not found in PATH' });
    const script = planSpawn('C:\\Tools\\run.ps1', [], machine(['C:\\Tools\\run.ps1'], { PATHEXT: '.PS1;.EXE' }));
    expect(script).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('leaves everything to the operating system elsewhere', () => {
    const plan = planSpawn('op', ['read'], { ...machine([]), platform: 'linux' });
    expect(plan).toEqual({ ok: true, plan: { command: 'op', args: ['read'], windowsVerbatimArguments: false, resolved: 'op' } });
  });
});

describe('prepareStdioCommand', () => {
  it('turns "npx" into the full path of npx.cmd so nothing is searched later', () => {
    const m = machine(['C:\\Program Files\\nodejs\\npx.cmd', 'C:\\repo\\npx.cmd']);
    expect(prepareStdioCommand('npx', ['-y', 'pkg'], m)).toEqual({ ok: true, command: 'C:\\Program Files\\nodejs\\npx.cmd' });
  });

  it('does not pick a program planted in the working directory', () => {
    const result = prepareStdioCommand('npx', [], machine(['C:\\repo\\npx.cmd', 'C:\\repo\\npx.exe']));
    expect(result).toMatchObject({ ok: false, code: 'ENOENT' });
  });

  it('refuses shim arguments cmd.exe cannot carry, but not the same arguments for an .exe', () => {
    expect(prepareStdioCommand('npx', ['--arg', '50%'], machine(['C:\\Program Files\\nodejs\\npx.cmd']))).toMatchObject({ ok: false, code: 'EINVAL' });
    expect(prepareStdioCommand('node', ['--arg', '50%'], machine(['C:\\Program Files\\nodejs\\node.exe']))).toEqual({ ok: true, command: 'C:\\Program Files\\nodejs\\node.exe' });
  });

  it('refuses a file type it cannot start', () => {
    expect(prepareStdioCommand('tool.ps1', [], machine(['C:\\Tools\\tool.ps1'], { PATHEXT: '.PS1;.EXE' }))).toMatchObject({ ok: false, code: 'EINVAL' });
  });

  it('changes nothing off Windows', () => {
    expect(prepareStdioCommand('npx', ['x'], { ...machine([]), platform: 'darwin' })).toEqual({ ok: true, command: 'npx' });
  });
});
