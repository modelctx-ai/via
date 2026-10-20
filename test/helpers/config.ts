import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { loadConfig, type LoadConfigOptions, type LoadedConfig, type ServerConfig } from '../../src/config';

export const CONFIG_FIXTURES = fileURLToPath(new URL('../fixtures/config/', import.meta.url));

/** Loads against the sample tree in test/fixtures/config: `home/` is the home directory, `project/` the working directory. */
export function loadFixture(options: Partial<LoadConfigOptions> & { dataDir: string }): Promise<LoadedConfig> {
  return loadConfig({
    home: join(CONFIG_FIXTURES, 'home'),
    cwd: join(CONFIG_FIXTURES, 'project'),
    projectRoot: join(CONFIG_FIXTURES, 'project'),
    env: {},
    platform: 'linux',
    ...options,
  });
}

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix = 'via-config-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

export interface Tree {
  root: string;
  home: string;
  project: string;
  dataDir: string;
  load(options?: Partial<LoadConfigOptions>): Promise<LoadedConfig>;
}

/**
 * A scratch tree: `files` maps paths relative to the root (`home/.cursor/mcp.json`,
 * `project/.via.yaml`) to content. Loading runs with `home/` as home and `project/` as the
 * working directory, and never sees the real environment.
 */
export function makeTree(files: Record<string, string>): Tree {
  const root = tempDir();
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, 'data');
  return {
    root,
    home,
    project,
    dataDir,
    load: (options = {}) => loadConfig({ home, cwd: project, projectRoot: project, env: {}, platform: 'linux', dataDir, ...options }),
  };
}

export function copyFixtureTree(): string {
  const dir = tempDir();
  cpSync(CONFIG_FIXTURES, dir, { recursive: true });
  return dir;
}

export function server(config: LoadedConfig, name: string): ServerConfig {
  const found = config.servers.find((s) => s.name === name);
  if (!found) throw new Error(`no server ${name}; have ${config.servers.map((s) => s.name).join(', ')}`);
  return found;
}

/** path -> content for every file below `dir`, to prove a load changed nothing. */
export function snapshotTree(dir: string, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) snapshotTree(path, out);
    else out[path] = readFileSync(path, 'utf8');
  }
  return out;
}
