// SHA-256 without loading `node:crypto`.
//
// Loading `node:crypto` costs 6-10 ms on a cold start (it initialises OpenSSL bindings, hash,
// cipher, keygen, webcrypto, x509...), and a browse command only hashes a few short strings: the
// catalog cache key of each server and, when a config file launches a process, that file's bytes
// for the trust check. A plain implementation is faster for those; large inputs go to `node:crypto`
// (implementation.md, "启动速度"). The output is the standard digest, so existing cache file names
// and trust records stay valid. Not for secrets-sensitive comparisons: nothing here is constant-time.

import { builtin } from './builtin';

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Inputs above this many bytes are hashed by `node:crypto`, which is faster once it is loaded. */
const NATIVE_THRESHOLD = 64 * 1024;

const HEX = '0123456789abcdef';

/** The plain-JS digest, whatever the size (exported for the tests). */
export function sha256HexPure(bytes: Uint8Array): string {
  const length = bytes.length;
  // Message, 0x80, zero padding and the 64-bit bit length, in whole 64-byte blocks.
  const total = ((length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(total);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(total - 8, Math.floor(length / 0x20000000), false);
  view.setUint32(total - 4, (length << 3) >>> 0, false);

  let h0 = 0x6a09e667 | 0;
  let h1 = 0xbb67ae85 | 0;
  let h2 = 0x3c6ef372 | 0;
  let h3 = 0xa54ff53a | 0;
  let h4 = 0x510e527f | 0;
  let h5 = 0x9b05688c | 0;
  let h6 = 0x1f83d9ab | 0;
  let h7 = 0x5be0cd19 | 0;
  const w = new Int32Array(64);

  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getInt32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }

  let out = '';
  for (const word of [h0, h1, h2, h3, h4, h5, h6, h7]) {
    for (let shift = 28; shift >= 0; shift -= 4) out += HEX[(word >>> shift) & 15];
  }
  return out;
}

/** Hex SHA-256 of a string (UTF-8) or of bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  if (bytes.length > NATIVE_THRESHOLD) {
    return builtin<typeof import('node:crypto')>('node:crypto').createHash('sha256').update(bytes).digest('hex');
  }
  return sha256HexPure(bytes);
}
