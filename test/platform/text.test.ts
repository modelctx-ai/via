import { describe, expect, it } from 'vitest';
import { decodeText } from '../../src/platform/text';

const utf16le = (text: string, bom = true): Buffer => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, 'utf16le')]);
const utf16be = (text: string): Buffer => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);

describe('decodeText', () => {
  it('reads plain UTF-8 as is', () => {
    expect(decodeText(Buffer.from('héllo · 你好'))).toBe('héllo · 你好');
    expect(decodeText(Buffer.alloc(0))).toBe('');
  });

  it('drops a UTF-8 byte order mark', () => {
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]))).toBe('{"a":1}');
  });

  it('decodes UTF-16 with a byte order mark, as PowerShell 5.1 redirection writes it', () => {
    expect(decodeText(utf16le('{"tool":"gh/pr:list"}\r\n'))).toBe('{"tool":"gh/pr:list"}\r\n');
    expect(decodeText(utf16be('你好 token'))).toBe('你好 token');
  });

  it('does not guess UTF-16 without a mark, and ignores a dangling byte', () => {
    expect(decodeText(utf16le('ab', false))).toBe('a\u0000b\u0000');
    expect(decodeText(Buffer.concat([utf16le('ab'), Buffer.from([0x41])]))).toBe('ab');
  });

  it('accepts a view into a larger buffer', () => {
    const big = Buffer.concat([Buffer.from('xxxx'), utf16le('ok'), Buffer.from('yyyy')]);
    expect(decodeText(big.subarray(4, 4 + 2 + 4))).toBe('ok');
  });
});
