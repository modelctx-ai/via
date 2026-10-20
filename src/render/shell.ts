/**
 * A word safe to paste into the user's shell: as is when plain, else quoted. For `next:` lines that
 * carry a path. POSIX shells get single quotes. On Windows a backslash is a path separator and not
 * an escape, and both cmd.exe and PowerShell take double quotes, so a path with spaces is wrapped
 * in those; one with a character that is special inside them (a double quote, `$`, a backtick or
 * `%`) falls back to PowerShell's single quotes, the shell an agent on Windows most likely has.
 */
export function shellWord(text: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    if (/^[\w@+=:,./\\~-]+$/.test(text)) return text;
    if (!/["$`%\r\n]/.test(text)) return `"${text}"`;
    return `'${text.replace(/'/g, "''")}'`;
  }
  if (/^[\w@%+=:,./~-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
