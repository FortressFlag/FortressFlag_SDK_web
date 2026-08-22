// Unpadded base64url, the contract's only binary-to-text encoding (payloads, signatures,
// the X-FF-Tags header, device-ID bodies).
//
// Byte-oriented on purpose: `btoa` is only safe on binary strings whose char codes are
// 0–255, which raw bytes always are — but arbitrary TEXT is not (an emoji kills it
// mid-fetch), so every caller converts text through TextEncoder first and hands bytes here.

/** Unpadded base64url of [bytes]. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decodes unpadded base64url, or null when [text] is not that. The alphabet is checked
 * before `atob` sees anything: `atob` tolerates characters this contract does not.
 */
export function decodeBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
