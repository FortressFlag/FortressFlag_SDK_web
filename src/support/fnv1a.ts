/**
 * FNV-1a (32-bit) over a string's UTF-8 bytes, as lowercase hex.
 *
 * This is NAMESPACING, not secrecy — the property SHA-256 provided on iOS/Android was "the
 * SDK key never lands in a file path"; in `localStorage` the analogous rule is "not in a
 * storage key readable in devtools exports", and the key is public by design anyway.
 * `crypto.subtle` is async AND unavailable on insecure origins (where local dev lives), so a
 * synchronous non-cryptographic hash does the job the platform actually needs (ADR-0014).
 */
export function fnv1aHex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    // 32-bit FNV prime multiply, kept in uint32 without BigInt: 16777619 = 2^24 + 2^8 + 0x93.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
