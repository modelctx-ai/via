// Text from files and pipes written by Windows tools: Notepad and PowerShell 5.1 (`>`, `Out-File`)
// write UTF-8 with a BOM or UTF-16, and a UTF-8 decoder would turn the latter into garbage that
// still parses as "some text", for instance a credential that quietly never works.

/** Decode `bytes` as text: a UTF-8 or UTF-16 byte order mark selects the encoding (and is dropped), else UTF-8. */
export function decodeText(bytes: Uint8Array): string {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2, 2 + ((b.length - 2) & ~1)).toString('utf16le');
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    const body = Buffer.from(b.subarray(2, 2 + ((b.length - 2) & ~1))); // a copy: swap16 works in place
    return body.swap16().toString('utf16le');
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8');
  return b.toString('utf8');
}
