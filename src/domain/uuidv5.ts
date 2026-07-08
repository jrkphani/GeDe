// A small, dependency-free UUIDv5 (RFC 4122 §4.3) implementation.
//
// Why this exists instead of the `uuid` npm package: this repo has no `uuid`
// dependency anywhere in its tree (only `uuidv7`, which generates random,
// time-ordered ids — the opposite of what a DETERMINISTIC id needs). Adding
// a new dependency for one pure function isn't worth it, especially since
// this file must import cleanly into BOTH the Vite browser bundle
// (src/store/auth.ts) and the esbuild-bundled Cognito Lambda
// (src/server/provisionWorkspace/albAdapter.ts) — a plain, runtime-agnostic
// TS module with no Node-specific (`node:crypto`) or Web-only (`crypto.subtle`,
// which is async) API avoids a two-implementation fork between those targets.
//
// Correctness is verified in uuidv5.test.ts against the well-known
// NAMESPACE_DNS + "python.org" cross-implementation test vector.

/** RFC 4122's predefined DNS namespace — used here only as a test vector. */
export const NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

function rotl(n: number, x: number): number {
  return (x << n) | (x >>> (32 - n))
}

/** SHA-1 (FIPS 180-4) over raw bytes. Only used to feed UUIDv5 below — not exported. */
function sha1(data: Uint8Array): Uint8Array {
  const bitLength = data.length * 8

  // Padding: append a single 1-bit (0x80), zero-pad, then the 64-bit
  // big-endian bit length, so the total length is a multiple of 64 bytes.
  const paddedLength = (((data.length + 8) >>> 6) << 6) + 64
  const padded = new Uint8Array(paddedLength)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  // High 32 bits of the 64-bit length are always 0 here — every name this
  // module hashes (a namespace UUID + a Cognito `sub`) is far under 2^29 bytes.
  view.setUint32(paddedLength - 4, bitLength >>> 0)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0

  const w = new Int32Array(80)
  for (let chunkStart = 0; chunkStart < padded.length; chunkStart += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(chunkStart + i * 4)
    }
    for (let i = 16; i < 80; i++) {
      const wi3 = w[i - 3] as number
      const wi8 = w[i - 8] as number
      const wi14 = w[i - 14] as number
      const wi16 = w[i - 16] as number
      w[i] = rotl(1, wi3 ^ wi8 ^ wi14 ^ wi16)
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4

    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const wi = w[i] as number
      const temp = (rotl(5, a) + f + e + k + wi) | 0
      e = d
      d = c
      c = rotl(30, b)
      b = a
      a = temp
    }

    h0 = (h0 + a) | 0
    h1 = (h1 + b) | 0
    h2 = (h2 + c) | 0
    h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0
  }

  const out = new Uint8Array(20)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, h0 >>> 0)
  outView.setUint32(4, h1 >>> 0)
  outView.setUint32(8, h2 >>> 0)
  outView.setUint32(12, h3 >>> 0)
  outView.setUint32(16, h4 >>> 0)
  return out
}

function parseUuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '')
  if (hex.length !== 32 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error(`Not a valid UUID: ${uuid}`)
  }
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number.parseInt(hex.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20, 32),
  ].join('-')
}

/**
 * UUIDv5 (RFC 4122 §4.3): `SHA-1(namespace_bytes || name_utf8_bytes)`,
 * truncated to 16 bytes with the version (5) and variant (RFC 4122) nibbles
 * overwritten. Deterministic: the same `(namespace, name)` pair always
 * produces the same id, which is the entire point of using it for
 * src/domain/workspaceId.ts's `workspaceIdForSub` — see that file for why a
 * deterministic id (rather than this repo's usual random `uuidv7()`) is
 * required here.
 */
export function uuidv5(namespace: string, name: string): string {
  const namespaceBytes = parseUuidToBytes(namespace)
  const nameBytes = new TextEncoder().encode(name)
  const combined = new Uint8Array(namespaceBytes.length + nameBytes.length)
  combined.set(namespaceBytes)
  combined.set(nameBytes, namespaceBytes.length)

  const hash = sha1(combined)
  const bytes = hash.slice(0, 16)
  const byte6 = bytes[6] as number
  const byte8 = bytes[8] as number
  bytes[6] = (byte6 & 0x0f) | 0x50 // version 5
  bytes[8] = (byte8 & 0x3f) | 0x80 // RFC 4122 variant
  return bytesToUuid(bytes)
}
