/** A word safe to paste into a POSIX shell: as is when plain, else single-quoted. For `next:` lines that carry a path. */
export function shellWord(text: string): string {
  if (/^[\w@%+=:,./~-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
