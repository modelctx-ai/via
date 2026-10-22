// `via skills`: the pure part (cli.md, "skills"; ADR 0020). Turns the skills extension's entries into the
// shapes the render pipeline already handles, and finds the skill a typed name stands for.
import { normalizeInput } from '../catalog/resolve';
import { shortDescription } from '../catalog/signature';
import { SKILL_FILE, skillFileNames, skillPath } from '../client/skills';
import type { SkillEntry, SkillRead } from '../protocol';
import { shellWords, visibleText } from '../render/shell';
import type { ContentBlock, OutputFormat, ToolResult } from '../render/types';
import { alignRows } from '../render/width';

/** How many supporting files `via skills <provider> <name>` names on stderr before `… N more`. */
export const FILES_SHOWN = 8;

/** The name a skill is listed under: its frontmatter name, or its path when other skills share the name. */
function labels(skills: readonly SkillEntry[]): string[] {
  const count = new Map<string, number>();
  for (const s of skills) count.set(s.frontmatter.name, (count.get(s.frontmatter.name) ?? 0) + 1);
  return skills.map((s) => (count.get(s.frontmatter.name)! > 1 ? skillPath(s.uri) : s.frontmatter.name));
}

/** `via skills <provider>`: name, file count, description. `-o json` is the entries as the server published them. */
export function skillListing(skills: readonly SkillEntry[], provider: string, format: OutputFormat): ToolResult {
  if (format === 'json') return { content: [], structuredContent: skills };
  if (skills.length === 0) return { content: [{ type: 'text', text: '(no skills)' }] };
  const names = labels(skills);
  const rows = skills.map((s, i) => {
    const files = s.resources === 'dynamic' ? 'dynamic' : `${s.resources.length} file${s.resources.length === 1 ? '' : 's'}`;
    const description = shortDescription(s.frontmatter.description);
    return [visibleText(names[i]!), files, ...(description ? [visibleText(description)] : [])];
  });
  return { content: [{ type: 'text', text: [...alignRows(rows), `→ via skills ${shellWords(provider)} <name> to read a skill · <name> <file> for one of its files`].join('\n') }] };
}

export type FoundSkill = { kind: 'found'; uri: string } | { kind: 'ambiguous'; paths: string[] } | { kind: 'none'; names: string[] };

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The skill `input` names: a URI (of the skill or of its `SKILL.md`), else a name or path exactly as listed, else the same
 * leniently written (case, `-`/`_`), else a unique prefix. Names are labels, not identifiers: two skills under different
 * prefixes may share one, and then the match is ambiguous rather than picked.
 */
export function findSkill(skills: readonly SkillEntry[], input: string): FoundSkill {
  const typed = input.trim();
  if (SCHEME.test(typed)) {
    const known = skills.find((s) => s.uri === typed || skillPath(s.uri) === skillPath(typed));
    return { kind: 'found', uri: known?.uri ?? (typed.endsWith(`/${SKILL_FILE}`) ? typed : `${typed.replace(/\/+$/, '')}/${SKILL_FILE}`) };
  }
  const path = typed.replace(/^\/+|\/+$/g, '');
  const wanted = normalizeInput(path);
  const tiers: Array<(s: SkillEntry) => boolean> = [
    (s) => s.frontmatter.name === path || skillPath(s.uri) === path,
    (s) => normalizeInput(s.frontmatter.name) === wanted || normalizeInput(skillPath(s.uri)) === wanted,
    (s) => wanted !== '' && (normalizeInput(s.frontmatter.name).startsWith(wanted) || normalizeInput(skillPath(s.uri)).startsWith(wanted)),
  ];
  for (const tier of tiers) {
    const matches = skills.filter(tier);
    if (matches.length === 1) return { kind: 'found', uri: matches[0]!.uri };
    if (matches.length > 1) return { kind: 'ambiguous', paths: matches.map((s) => skillPath(s.uri)) };
  }
  return { kind: 'none', names: skills.map((s) => s.frontmatter.name) };
}

/** The verified file as a `resources/read` content, so `-o raw`, budgets, cursors and media files work as for `via read`. */
export function skillFileResult(read: SkillRead, format: OutputFormat): ToolResult {
  if (format === 'json') {
    const { file } = read;
    return {
      content: [],
      structuredContent: {
        skill: { uri: read.skill.uri, name: read.skill.frontmatter.name, description: read.skill.frontmatter.description, files: skillFileNames(read.skill) },
        file: { uri: file.uri, ...(file.mimeType ? { mimeType: file.mimeType } : {}), ...(file.text !== undefined ? { text: file.text } : {}), ...(file.blob !== undefined ? { size: Buffer.from(file.blob, 'base64').length } : {}) },
        verified: read.verified,
      },
    };
  }
  const block: ContentBlock = { type: 'resource', resource: { uri: read.file.uri, ...(read.file.mimeType ? { mimeType: read.file.mimeType } : {}), ...(read.file.text !== undefined ? { text: read.file.text } : {}), ...(read.file.blob !== undefined ? { blob: read.file.blob } : {}) } };
  return { content: [block] };
}

/** The line after a `SKILL.md`: which other files the skill has and how to read one. Empty when there are none (or the manifest is `"dynamic"`). */
export function filesHint(read: SkillRead, provider: string): string {
  const others = skillFileNames(read.skill).filter((f) => f !== SKILL_FILE);
  if (others.length === 0) return '';
  const shown = others.slice(0, FILES_SHOWN).map((f) => visibleText(f));
  const more = others.length > FILES_SHOWN ? ` · … ${others.length - FILES_SHOWN} more` : '';
  return `files: ${shown.join(' · ')}${more}  (via skills ${shellWords(provider)} ${shellWords([skillPath(read.skill.uri)], { placeholder: 'name' })} <file>)\n`;
}
