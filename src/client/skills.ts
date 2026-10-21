// The skills extension (`io.modelcontextprotocol/skills`, MCP 2026-07-28): entries, manifests and the check
// that what a server sends is what its manifest published (cli.md, "skills"; ADR 0020). Pure: the session
// does the requests, this decides what to ask for and whether to believe the answer. The check lives next to
// the client, not in the CLI, because the daemon redacts what it returns: a digest has to be compared with the
// bytes the server sent, before any credential was replaced in them.
import { sha256Hex } from '../sha256';
import type { SkillEntry, SkillFile } from '../protocol';

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';

/** The file every skill has, and the tail of every skill URI. */
export const SKILL_FILE = 'SKILL.md';

/** `sha256:` and exactly 64 lowercase hex characters, as the extension defines a digest. */
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseFile(value: unknown): SkillFile | undefined {
  if (!isRecord(value)) return undefined;
  const { uri, digest, size } = value;
  if (typeof uri !== 'string' || uri === '' || typeof digest !== 'string' || !DIGEST.test(digest)) return undefined;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) return undefined;
  return { uri, digest, size };
}

/**
 * A skill entry, or undefined when it is not one a client may use: the extension requires the `SKILL.md` URI, the
 * `name` and `description` of its frontmatter, and a manifest that is the complete file list or the string
 * `"dynamic"`. An entry that fails any of it is dropped, never repaired.
 */
export function parseSkillEntry(value: unknown): SkillEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { uri, frontmatter, resources } = value;
  if (typeof uri !== 'string' || uri === '' || !isRecord(frontmatter)) return undefined;
  if (typeof frontmatter.name !== 'string' || frontmatter.name === '' || typeof frontmatter.description !== 'string') return undefined;
  let manifest: SkillEntry['resources'];
  if (resources === 'dynamic') manifest = 'dynamic';
  else if (Array.isArray(resources)) {
    const files = resources.map(parseFile);
    if (files.some((f) => f === undefined)) return undefined;
    manifest = files as SkillFile[];
  } else return undefined;
  return { uri, frontmatter: { ...frontmatter, name: frontmatter.name, description: frontmatter.description }, resources: manifest };
}

/** The directory of a skill: its `SKILL.md` URI without the file name. */
export function skillRoot(uri: string): string {
  return uri.endsWith(`/${SKILL_FILE}`) ? uri.slice(0, -(SKILL_FILE.length + 1)) : uri.replace(/\/+$/, '');
}

/** The part of a skill's URI after the scheme and before `/SKILL.md` (`skill://acme/refunds/SKILL.md` is `acme/refunds`). */
export function skillPath(uri: string): string {
  const root = skillRoot(uri);
  const at = root.indexOf('://');
  return at >= 0 ? root.slice(at + 3) : root;
}

/** The file names of a skill, relative to its directory (what the person types). `"dynamic"` manifests list none. */
export function skillFileNames(skill: SkillEntry): string[] {
  if (skill.resources === 'dynamic') return [];
  const root = `${skillRoot(skill.uri)}/`;
  return skill.resources.map((f) => (f.uri.startsWith(root) ? f.uri.slice(root.length) : f.uri));
}

export type FileChoice = { uri: string } | { problem: 'empty' | 'escapes' | 'unlisted'; files: string[] };

/**
 * The URI a typed file name stands for: the manifest's own URI when it matches exactly, else the name relative
 * to the skill's directory (`./` and a leading `/` are ignored; `..` is refused, it would leave the directory).
 * With a complete manifest, a file that is not in it is not a file of the skill, and is not asked for.
 */
export function chooseFile(skill: SkillEntry, typed: string | undefined): FileChoice {
  if (typed === undefined) return { uri: skill.uri };
  const files = skillFileNames(skill);
  if (skill.resources !== 'dynamic') {
    const exact = skill.resources.find((f) => f.uri === typed);
    if (exact) return { uri: exact.uri };
  }
  const path = typed.trim().replace(/^\.\//, '').replace(/^\/+/, '');
  if (path === '') return { problem: 'empty', files };
  if (path.split('/').includes('..')) return { problem: 'escapes', files };
  const uri = `${skillRoot(skill.uri)}/${path}`;
  if (skill.resources !== 'dynamic' && !skill.resources.some((f) => f.uri === uri)) return { problem: 'unlisted', files };
  return { uri };
}

/** The bytes of a `resources/read` content: UTF-8 for `text`, decoded for `blob`; undefined when it has neither. */
export function contentBytes(content: { text?: unknown; blob?: unknown }): Uint8Array | undefined {
  if (typeof content.blob === 'string') return Buffer.from(content.blob, 'base64');
  if (typeof content.text === 'string') return Buffer.from(content.text, 'utf8');
  return undefined;
}

/**
 * What is wrong with `bytes` as the file `uri`, judged by the skill's manifest; undefined when it is right.
 * A `"dynamic"` manifest publishes nothing to judge by, so it passes (the caller says the content is unverified).
 */
export function verifyFile(skill: SkillEntry, uri: string, bytes: Uint8Array): string | undefined {
  if (skill.resources === 'dynamic') return undefined;
  const entry = skill.resources.find((f) => f.uri === uri);
  if (!entry) return 'it is not in the skill\'s manifest';
  if (bytes.length !== entry.size) return `the manifest says ${entry.size} bytes, the server sent ${bytes.length}`;
  const digest = `sha256:${sha256Hex(bytes)}`;
  if (digest !== entry.digest) return `its sha256 differs from the manifest's (${entry.digest.slice(0, 19)}… expected, ${digest.slice(0, 19)}… received)`;
  return undefined;
}
