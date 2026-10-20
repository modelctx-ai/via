// Output that is compared against a checked-in snapshot must read the same on every host.

/** Windows prints paths with `\`; snapshots are written with `/`. A no-op elsewhere. */
export function portablePaths(text: string): string {
  return process.platform === 'win32' ? text.replaceAll('\\', '/') : text;
}

/**
 * For a padded table that contains a sandbox path: the column width follows the length of that
 * path, which differs between hosts (`/tmp/via-cli-x` vs `C:\Users\RUNNER~1\AppData\Local\Temp\via-cli-x`).
 * The cells (separated by two or more spaces) are padded again to the widest cell of the text
 * as it reads after the path was replaced by a placeholder. Cell contents and order are unchanged.
 */
export function portableTable(text: string): string {
  const rows = portablePaths(text)
    .split('\n')
    .map((line) => line.split(/ {2,}/));
  const widths: number[] = [];
  for (const cells of rows) cells.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((cells) => cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]! + 2))).join('')).join('\n');
}
