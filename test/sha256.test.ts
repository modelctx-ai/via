import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex, sha256HexPure } from '../src/sha256';

const reference = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

// A tiny seeded generator, so the byte patterns are the same on every run.
function bytesOf(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

describe('sha256Hex', () => {
  it('matches the standard test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('agrees with node:crypto at every length around the block and padding boundaries', () => {
    for (let length = 0; length <= 200; length += 1) {
      const data = bytesOf(length, length + 1);
      expect(sha256HexPure(data), `length ${length}`).toBe(reference(data));
    }
  });

  it('agrees on strings with multi-byte characters', () => {
    for (const text of ['héllo', '日本語のツール', 'a\0b\0c', '😀 emoji', JSON.stringify({ v: 1, transport: { type: 'http', url: 'https://example.com/mcp' } })]) {
      expect(sha256Hex(text)).toBe(reference(text));
    }
  });

  it('agrees on large inputs, on both the plain and the native path', () => {
    for (const length of [65_535, 65_536, 65_537, 300_000]) {
      const data = bytesOf(length, 7);
      expect(sha256HexPure(data)).toBe(reference(data));
      expect(sha256Hex(data)).toBe(reference(data));
    }
  });
});
