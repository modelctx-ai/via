// Path rules per platform (config.md, "配置文件"). Windows is injected as `platform: 'win32'`, so
// these run, with the same result, on every host.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  expandPath,
  getEnv,
  normalizeWindowsPath,
  pathContext,
  pathIdentity,
  shortenHome,
  userCacheDir,
  userConfigDir,
  userConfigPath,
  userDataDir,
} from '../../src/config/paths';
import { shellWord } from '../../src/render/shell';

const win = (env: Record<string, string> = {}) => pathContext({ home: 'C:\\Users\\Me', env, platform: 'win32' });

describe('Windows directories', () => {
  it('puts the config in %APPDATA%\\via, the data and cache under %LOCALAPPDATA%\\via', () => {
    const ctx = win({ APPDATA: 'D:\\Roaming', LOCALAPPDATA: 'D:\\Local' });
    expect(userConfigDir(ctx)).toBe('D:\\Roaming\\via');
    expect(userConfigPath(ctx)).toBe('D:\\Roaming\\via\\config.yaml');
    expect(userDataDir(ctx)).toBe('D:\\Local\\via\\Data');
    expect(userCacheDir(ctx)).toBe('D:\\Local\\via\\Cache');
  });

  it('falls back to the profile directory when the variables are missing', () => {
    expect(userConfigDir(win())).toBe('C:\\Users\\Me\\AppData\\Roaming\\via');
    expect(userDataDir(win())).toBe('C:\\Users\\Me\\AppData\\Local\\via\\Data');
    expect(userCacheDir(win())).toBe('C:\\Users\\Me\\AppData\\Local\\via\\Cache');
  });

  it('finds variables whatever their case, as Windows does', () => {
    expect(userConfigDir(win({ appdata: 'D:\\R' }))).toBe('D:\\R\\via');
    expect(userCacheDir(win({ LocalAppData: 'D:\\L' }))).toBe('D:\\L\\via\\Cache');
    expect(getEnv({ Path: 'x' }, 'PATH', 'win32')).toBe('x');
    expect(getEnv({ Path: 'x' }, 'PATH', 'linux')).toBeUndefined();
  });

  it('ignores XDG_* on Windows, and uses it elsewhere', () => {
    const env = { XDG_CONFIG_HOME: '/xdg', XDG_CACHE_HOME: '/xdg-cache', XDG_DATA_HOME: '/xdg-data' };
    expect(userConfigDir(pathContext({ home: 'C:\\Users\\Me', env, platform: 'win32' }))).toBe('C:\\Users\\Me\\AppData\\Roaming\\via');
    expect(userConfigDir(pathContext({ home: '/home/me', env, platform: 'linux' }))).toBe(join('/xdg', 'via')); // host separators: a Windows host handed `linux` still builds Windows paths
    expect(userCacheDir(pathContext({ home: '/home/me', env, platform: 'darwin' }))).toBe(join('/home/me', 'Library', 'Caches', 'via'));
  });
});

describe('expandPath', () => {
  it('expands ~ and %NAME% with Windows separators', () => {
    const ctx = win({ APPDATA: 'D:\\Roaming' });
    expect(expandPath('~\\.cursor\\mcp.json', ctx)).toBe('C:\\Users\\Me\\.cursor\\mcp.json');
    expect(expandPath('~/.cursor/mcp.json', ctx)).toBe('C:\\Users\\Me\\.cursor\\mcp.json');
    expect(expandPath('%APPDATA%/Claude/claude_desktop_config.json', ctx)).toBe('D:\\Roaming/Claude/claude_desktop_config.json');
    expect(expandPath('%appdata%\\x', ctx)).toBe('D:\\Roaming\\x');
  });

  it('gives undefined for a variable that is not set, so the path is skipped', () => {
    expect(expandPath('%APPDATA%/x', win())).toBeUndefined();
    expect(expandPath('%APPDATA%/x', pathContext({ home: '/h', env: {}, platform: 'linux' }))).toBeUndefined();
  });
});

describe('Windows path identity', () => {
  it('drops \\\\?\\ prefixes, normalizes separators and upper-cases the drive letter', () => {
    expect(normalizeWindowsPath('c:/Users/me/./repo/../repo/.via.yaml')).toBe('C:\\Users\\me\\repo\\.via.yaml');
    expect(normalizeWindowsPath('\\\\?\\C:\\Users\\Me\\x')).toBe('C:\\Users\\Me\\x');
    expect(normalizeWindowsPath('\\\\.\\C:\\x')).toBe('C:\\x');
    expect(normalizeWindowsPath('\\\\?\\UNC\\server\\share\\x')).toBe('\\\\server\\share\\x');
  });

  it('compares case-insensitively on Windows only', () => {
    const a = pathIdentity('c:\\Repo\\.via.yaml', 'win32');
    expect(a).toBe(pathIdentity('C:/repo/.VIA.yaml', 'win32'));
    expect(a).toBe(pathIdentity('\\\\?\\C:\\REPO\\.via.yaml', 'win32'));
    expect(pathIdentity('C:\\Repo\\', 'win32')).toBe(pathIdentity('c:\\repo', 'win32'));
    expect(pathIdentity('/Repo/.via.yaml', 'linux')).not.toBe(pathIdentity('/repo/.via.yaml', 'linux'));
  });
});

describe('shortenHome', () => {
  it('shows ~ for the home directory with either separator', () => {
    expect(shortenHome('/home/u/.cursor/mcp.json', '/home/u', 'linux')).toBe('~/.cursor/mcp.json');
    expect(shortenHome('C:\\Users\\Me\\.cursor\\mcp.json', 'C:\\Users\\Me', 'win32')).toBe('~\\.cursor\\mcp.json');
    expect(shortenHome('c:\\users\\me\\x', 'C:\\Users\\Me\\', 'win32')).toBe('~\\x');
    expect(shortenHome('C:\\Users\\Me', 'C:\\Users\\Me', 'win32')).toBe('~');
  });

  it('leaves other paths alone, including a sibling that shares the prefix', () => {
    expect(shortenHome('/home/user2/x', '/home/u', 'linux')).toBe('/home/user2/x');
    expect(shortenHome('/Home/u/x', '/home/u', 'linux')).toBe('/Home/u/x');
    expect(shortenHome('/x', undefined, 'linux')).toBe('/x');
    expect(shortenHome('/x', '', 'linux')).toBe('/x');
  });
});

describe('shellWord', () => {
  it('quotes for POSIX shells with single quotes', () => {
    expect(shellWord('/a/b.json', 'linux')).toBe('/a/b.json');
    expect(shellWord('/a b/c.json', 'linux')).toBe("'/a b/c.json'");
    expect(shellWord("it's", 'darwin')).toBe("'it'\\''s'");
  });

  it('leaves a Windows path alone and double-quotes one with spaces, for cmd.exe and PowerShell alike', () => {
    expect(shellWord('C:\\Users\\Me\\repo\\.mcp.json', 'win32')).toBe('C:\\Users\\Me\\repo\\.mcp.json');
    expect(shellWord('C:\\Users\\Me Too\\.mcp.json', 'win32')).toBe('"C:\\Users\\Me Too\\.mcp.json"');
  });

  it('falls back to PowerShell single quotes when double quotes would expand something', () => {
    expect(shellWord('C:\\Users\\$me\\x y', 'win32')).toBe("'C:\\Users\\$me\\x y'");
    expect(shellWord('C:\\100%\\x', 'win32')).toBe("'C:\\100%\\x'");
    expect(shellWord("C:\\it's\\a b", 'win32')).toBe("\"C:\\it's\\a b\"");
    expect(shellWord("C:\\it's$\\a", 'win32')).toBe("'C:\\it''s$\\a'");
  });
});
