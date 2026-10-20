import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startOAuthServer } from '../fixtures/mcp/oauth-server.mjs';

// `via auth login --manual` against the built binary, with a real pipe on stdin: the redirect URL
// is read from the terminal, one line, and the process ends on its own afterwards.
const root = fileURLToPath(new URL('../..', import.meta.url));

let dir = '';
let bin = '';

beforeAll(() => {
  mkdirSync(join(root, '.build'), { recursive: true });
  dir = mkdtempSync(join(root, '.build', 'auth-'));
  const out = join(dir, 'out');
  const build = spawnSync(join(root, 'node_modules', '.bin', 'tsup'), ['--out-dir', out, '--silent'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  if (build.status !== 0) throw new Error(`tsup failed: ${build.stderr || build.stdout}`);
  bin = join(out, 'via.js');
}, 90_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('built dist/via.js: auth login --manual', () => {
  it('reads the pasted redirect URL from stdin', async () => {
    const srv = await startOAuthServer();
    try {
      const home = join(dir, 'home');
      mkdirSync(join(home, '.config', 'via'), { recursive: true });
      writeFileSync(join(home, '.config', 'via', 'config.yaml'), `sources: false\nservers:\n  linear:\n    url: ${srv.url}\n    auth: oauth\n`);
      const child = spawn(process.execPath, [bin, 'auth', 'login', 'linear', '--manual'], {
        cwd: home,
        env: { PATH: process.env.PATH, HOME: home, VIA_OAUTH_STORE: 'file', NODE_DISABLE_COMPILE_CACHE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      const exited = new Promise<number | null>((resolve) => child.once('close', resolve));

      // Wait for the prompt, authorize "elsewhere", paste the landing URL.
      const deadline = Date.now() + 15_000;
      while (!stderr.includes('paste the redirect URL: ') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(stderr).toContain('paste the redirect URL: ');
      const landed = await srv.approve(stdout.split('\n')[0]!);
      child.stdin.write(`${landed}\n`);

      const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r('hung'), 15_000))]);
      if (code === 'hung') child.kill();
      expect({ code, stderr }).toEqual({ code: 0, stderr: expect.any(String) });
      expect(stdout).toContain('logged in: linear');
      expect(stdout + stderr).not.toContain(srv.issuedAccessTokens()[0]!);
    } finally {
      await srv.close();
    }
  }, 60_000);
});
