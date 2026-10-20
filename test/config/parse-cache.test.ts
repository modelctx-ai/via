import { readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, recordTrust } from '../../src/config';
import { parseConfigText } from '../../src/config/parse';
import { ParseCache } from '../../src/config/parse-cache';
import { sha256Hex } from '../../src/sha256';
import { makeTree, tempDir } from '../helpers/config';

// The parse cache (config.md, "解析缓存"): parsed YAML kept by content hash, strings stored as
// offsets into the file so that no value of the file is ever copied into the cache directory.

async function parse(text: string, cache?: ParseCache): Promise<unknown> {
  return parseConfigText(text, 'yaml', cache ? { cache, key: () => sha256Hex(text) } : {});
}

const cacheFiles = (dir: string): string[] => (readdirSync(dir, { withFileTypes: true }).length > 0 ? readdirSync(dir).filter((n) => n.endsWith('.json')) : []);

const DOCUMENTS: Record<string, string> = {
  plain: 'servers:\n  gh:\n    url: https://api.example.com/mcp\n    timeout: 30\n    disabled: false\n    domain: ~\n',
  flow: 'servers: { a: { command: npx, args: [-y, "@x/y@1.2.3", "quoted"], env: { K: v } } }\n',
  quoted: "servers:\n  a:\n    url: 'http://127.0.0.1:1/mcp'\n    alias: \"name with spaces\"\n    empty: ''\n    also: \"\"\n",
  comments: '# top\nservers:   # trailing\n  a:  # x\n    url: http://h/mcp # why\n',
  numbers: 'a: 1\nb: -2\nc: 1.5\nd: 1e3\ne: 0x10\nf: 012\ng: true\nh: null\ni: ~\nj: yes\nk: "123"\n',
  lists: 'deny:\n  - "^a/.*"\n  - ^b/x\ndomains:\n  work: [a, b]\n',
  empty: '',
  scalar: 'just text',
  unicode: 'servers:\n  café:\n    url: http://h/日本語\n    note: "emoji 😀"\n',
  bom: '﻿servers:\n  a:\n    url: http://h/mcp\n',
  // The shapes below cannot be expressed as offsets; they are parsed every time.
  escapes: 'servers:\n  a:\n    url: "http://h/a\\tb"\n',
  doubled: "a: 'it''s'\n",
  multiline: 'a: first\n  second\nb: |\n  literal\n  block\nc: >\n  folded\n  text\n',
  alias: 'base: &b { url: http://h/mcp }\nservers:\n  a: *b\n',
  special: 'a: .inf\nb: .nan\nc: -0\n',
  protoKey: '__proto__:\n  x: 1\nb: 2\n',
  numberKey: '1: one\n2: two\n',
};

describe('ParseCache', () => {
  it.each(Object.entries(DOCUMENTS))('gives the same value with and without the cache: %s', async (_name, text) => {
    const dir = tempDir();
    const cache = new ParseCache(dir, 'test');
    const expected = await parse(text);
    const first = await parse(text, cache);
    const second = await parse(text, cache);
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
    // Own keys are the same too (a "__proto__" key stays an own property, in the same place).
    expect(JSON.stringify(Object.keys(second as object | null ?? {}))).toBe(JSON.stringify(Object.keys(expected as object | null ?? {})));
    if (!(typeof expected === 'object' && expected !== null)) return;
    expect(Object.getPrototypeOf(second)).toBe(Object.getPrototypeOf(expected));
  });

  it('caches what offsets can express and only that', async () => {
    const dir = tempDir();
    const cache = new ParseCache(dir, 'test');
    const stored: string[] = [];
    for (const [name, text] of Object.entries(DOCUMENTS)) {
      const before = cacheFiles(dir).length;
      await parse(text, cache);
      if (cacheFiles(dir).length > before) stored.push(name);
    }
    expect(stored.sort()).toEqual(['bom', 'comments', 'empty', 'flow', 'lists', 'numbers', 'plain', 'protoKey', 'quoted', 'scalar', 'unicode'].sort());
  });

  it('never writes a string of the file into the cache directory', async () => {
    const dir = tempDir();
    const cache = new ParseCache(dir, 'test');
    const SECRET = 'ghp_fakeSecretValueThatIsNotRealButLooksLikeOne0123456789';
    const text = `servers:\n  gh:\n    url: https://api.example.com/mcp\n    headers:\n      Authorization: "Bearer ${SECRET}"\n    env:\n      TOKEN: ${SECRET}\n    args: ["--key", ${SECRET}]\n`;
    const parsed = (await parse(text, cache)) as { servers: { gh: { env: { TOKEN: string } } } };
    expect(parsed.servers.gh.env.TOKEN).toBe(SECRET);
    expect(cacheFiles(dir)).toHaveLength(1);
    const stored = readFileSync(join(dir, cacheFiles(dir)[0]!), 'utf8');
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain('Bearer');
    expect(stored).not.toContain('api.example.com');
    expect(stored).not.toContain('servers');
    // And it still reproduces the document from the file.
    expect(await parse(text, cache)).toEqual(parsed);
  });

  it('is keyed by content: an edited file never gets another file\'s parse', async () => {
    const dir = tempDir();
    const cache = new ParseCache(dir, 'test');
    await parse('servers:\n  a:\n    url: http://one/mcp\n', cache);
    expect(await parse('servers:\n  a:\n    url: http://two/mcp\n', cache)).toEqual({ servers: { a: { url: 'http://two/mcp' } } });
    expect(cacheFiles(dir)).toHaveLength(2);
  });

  it('misses under another parser id (a new via or YAML library version)', async () => {
    const dir = tempDir();
    const text = 'servers:\n  a:\n    url: http://one/mcp\n';
    await parse(text, new ParseCache(dir, 'v1'));
    const key = sha256Hex(text);
    expect(new ParseCache(dir, 'v1').get(key, text)).toBeDefined();
    expect(new ParseCache(dir, 'v2').get(key, text)).toBeUndefined();
  });

  it('ignores a corrupt file, a different layout and offsets that do not fit the file', async () => {
    const dir = tempDir();
    const cache = new ParseCache(dir, 'test');
    const text = 'servers:\n  a:\n    url: http://one/mcp\n';
    await parse(text, cache);
    const file = join(dir, cacheFiles(dir)[0]!);
    const good = readFileSync(file, 'utf8');
    for (const bad of ['{not json', 'null', '[]', '{"v":99,"id":"test","shape":null}', '{"v":1,"id":"test","shape":{"m":[[0,5],[999999,1000000]]}}', '{"v":1,"id":"test","shape":{"m":[[0,5]]}}', '{"v":1,"id":"test","shape":"text"}', '{"v":1,"id":"test","shape":{"zz":[]}}']) {
      writeFileSync(file, bad);
      expect(cache.get(sha256Hex(text), text), bad).toBeUndefined();
      // and the document still parses
      expect(await parse(text, cache)).toEqual({ servers: { a: { url: 'http://one/mcp' } } });
    }
    writeFileSync(file, good);
    expect(cache.get(sha256Hex(text), text)).toBeDefined();
  });

  it('keeps the newest sixteen files', async () => {
    const dir = tempDir();
    const cache = new ParseCache(dir, 'test');
    const text = (i: number): string => `servers:\n  s${i}:\n    url: http://h${i}/mcp\n`;
    for (let i = 0; i < 20; i += 1) {
      await parse(text(i), cache);
      // Distinct, increasing modification times, whatever the clock resolution.
      const when = new Date(1_700_000_000_000 + i * 60_000);
      utimesSync(join(dir, `${sha256Hex(text(i))}.json`), when, when);
    }
    const kept = cacheFiles(dir);
    expect(kept).toHaveLength(16);
    expect(kept).toContain(`${sha256Hex(text(19))}.json`);
    expect(kept).not.toContain(`${sha256Hex(text(0))}.json`);
  });

  it('does not fail when the directory cannot be written', async () => {
    const dir = join(tempDir(), 'blocked');
    writeFileSync(dir, 'a file where the directory should be');
    expect(await parse('a: 1\n', new ParseCache(dir, 'test'))).toEqual({ a: 1 });
  });
});

describe('loadConfig with the parse cache', () => {
  const YAML = 'sources: false\nservers:\n  gh:\n    url: https://api.example.com/mcp\n    auth: { bearer: "env:GH_TOKEN" }\n    timeout: 45\ndeny: ["^gh/delete"]\n';

  it('loads the same configuration from the cache as from the file, and follows edits', async () => {
    const cacheDir = join(tempDir(), 'config');
    const tree = makeTree({ 'home/.config/via/config.yaml': YAML });
    const plain = await tree.load();
    const first = await tree.load({ parseCacheDir: cacheDir });
    const second = await tree.load({ parseCacheDir: cacheDir });
    expect(cacheFiles(cacheDir)).toHaveLength(1);
    expect(second).toEqual(plain);
    expect(first).toEqual(plain);
    // Edit the file: the next load sees the edit, not the cached parse.
    writeFileSync(join(tree.home, '.config', 'via', 'config.yaml'), YAML.replace('timeout: 45', 'timeout: 90'));
    const edited = await tree.load({ parseCacheDir: cacheDir });
    expect(edited.servers[0]!.timeout).toBe(90);
    expect(cacheFiles(cacheDir)).toHaveLength(2);
  });

  it('does not change the trust of a project config: its bytes are hashed and checked as before', async () => {
    const cacheDir = join(tempDir(), 'config');
    const project = 'servers:\n  evil:\n    command: sh\n    args: ["-c", "echo hi"]\n';
    const tree = makeTree({ 'project/.via.yaml': project, 'home/.config/via/config.yaml': 'sources: false\n' });
    for (let i = 0; i < 2; i += 1) {
      const config = await tree.load({ parseCacheDir: cacheDir, dataDir: tree.dataDir });
      const evil = config.servers.find((s) => s.name === 'evil')!;
      expect(evil.trusted).toBe(false);
      expect(config.files.find((f) => f.path.endsWith('.via.yaml'))!.sha256).toBe(sha256Hex(project));
    }
    // Trusting the file records the hash of its bytes; the cached run honours it...
    const path = join(tree.project, '.via.yaml');
    recordTrust(tree.dataDir, path);
    expect((await tree.load({ parseCacheDir: cacheDir, dataDir: tree.dataDir })).servers.find((s) => s.name === 'evil')!.trusted).toBe(true);
    // ...and a changed file is untrusted again even though an older parse is cached.
    writeFileSync(path, `${project}    cwd: /tmp\n`);
    expect((await tree.load({ parseCacheDir: cacheDir, dataDir: tree.dataDir })).servers.find((s) => s.name === 'evil')!.trusted).toBe(false);
  });

  it('writes nothing unless a directory is given', async () => {
    const tree = makeTree({ 'home/.config/via/config.yaml': YAML });
    await tree.load();
    expect(readdirSync(tree.root).sort()).toEqual(['home', 'project']);
  });
});

describe('loadConfig reads valid JSON without a parser library', () => {
  it('gives the same servers for a JSONC file with and without comments', async () => {
    const body = '{"servers":{"a":{"command":"npx","args":["-y","x"]},"b":{"type":"http","url":"http://h/mcp"}}}';
    const files = (text: string) => ({ 'home/.config/Code/User/mcp.json': text, 'home/.config/via/config.yaml': 'sources: [vscode]\n' });
    const plain = makeTree(files(body));
    const commented = makeTree(files(`// c\n${body.replace('"b"', '/* b */ "b",').replace('"b",:', '"b":')}`));
    const names = async (t: typeof plain) => (await t.load()).servers.map((s) => [s.name, s.transport]);
    const expected = await names(plain);
    expect(expected.map(([name]) => name)).toEqual(['a', 'b']);
    expect(await names(commented)).toEqual(expected);
  });
});
