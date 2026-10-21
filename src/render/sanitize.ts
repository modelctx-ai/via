/** Strip ANSI escape sequences and control characters (except newline and tab) from upstream text. */
export function sanitizeText(text: string): string {
  return (
    text
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\u001b[@-Z\\-_]/g, '')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  );
}
