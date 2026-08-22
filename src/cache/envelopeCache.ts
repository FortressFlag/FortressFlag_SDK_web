import type { Environment } from "../configuration.js";
import { fnv1aHex } from "../support/fnv1a.js";
import type { Log } from "../support/log.js";

/** What the cache holds: the bytes that were signed, plus the ETag they arrived with. */
export interface CachedEnvelope {
  readonly raw: Uint8Array;
  readonly etag: string | null;
}

/**
 * Durable storage for the last envelope this browser received.
 *
 * The cache is a **correctness feature, not an optimisation** (Founding §8.4). It is what
 * makes "offline" and "our backend is down" indistinguishable from normal operation for the
 * end user, so it must survive page reloads and browser restarts, and every failure to read
 * it must degrade rather than throw.
 */
export interface EnvelopeCache {
  load(): CachedEnvelope | null;
  store(raw: Uint8Array, etag: string | null): void;
  clear(): void;
  /** Removes the stored ETag only. A tag change makes the stored validator stale without
   * invalidating the cached values themselves. */
  clearEtag(): void;
}

/**
 * A hostile or broken server must not be able to fill the origin's storage quota. Real
 * payloads are a few kilobytes; this is orders of magnitude of headroom and still bounded.
 * Shared with the transport's response cap.
 */
export const MAX_ENVELOPE_BYTES = 1 << 20;

/**
 * `localStorage`-backed cache.
 *
 * It stores **the signed envelope verbatim**, never the parsed values, and the caller
 * re-verifies on load. That single decision is what makes the cache safe: poisoning it
 * requires forging a signature rather than editing a JSON string in devtools — and once
 * backend M4 ships signing, the cache inherits every guarantee the transport has, for free,
 * and cannot drift from it. (The envelope is UTF-8 JSON, so the string round-trip through
 * `localStorage` preserves the exact bytes.)
 *
 * Keys are scoped by an FNV-1a hash of `"<sdkKey>|<environment>"` so two configurations on
 * one origin — a staging and a production page sharing storage, or a page reconfiguring at
 * runtime — cannot serve each other's values. Hashed for namespacing, not secrecy: the key
 * is public by design, and the rule being honoured is "the SDK key does not appear in a
 * storage key readable in a devtools export" (see fnv1a.ts for why not SHA-256 here).
 */
export class LocalStorageEnvelopeCache implements EnvelopeCache {
  private readonly envelopeKey: string;
  private readonly etagKey: string;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(
    sdkKey: string,
    environment: Environment,
    private readonly log: Log,
    private readonly storage: () => Storage | null = defaultStorage,
  ) {
    const scope = fnv1aHex(`${sdkKey}|${environment.key}`);
    this.envelopeKey = `fortressflag.cache.${scope}.envelope`;
    this.etagKey = `fortressflag.cache.${scope}.etag`;
  }

  load(): CachedEnvelope | null {
    const storage = this.storage();
    if (storage === null) return null;
    try {
      const text = storage.getItem(this.envelopeKey);
      if (text === null) return null;
      if (text.length > MAX_ENVELOPE_BYTES) {
        // Something wrote a value we would never have written. Treat as absent and remove
        // it: leaving it would mean retrying a doomed read on every load.
        this.log.warning("cached envelope is implausibly large; discarding it");
        this.clear();
        return null;
      }
      const etag = storage.getItem(this.etagKey);
      return { raw: this.encoder.encode(text), etag };
    } catch {
      return null;
    }
  }

  store(raw: Uint8Array, etag: string | null): void {
    if (raw.length > MAX_ENVELOPE_BYTES) return;
    const storage = this.storage();
    if (storage === null) return;
    try {
      storage.setItem(this.envelopeKey, this.decoder.decode(raw));
      if (etag !== null) {
        storage.setItem(this.etagKey, etag);
      } else {
        storage.removeItem(this.etagKey);
      }
    } catch {
      // A cache write failing (quota, private mode) is survivable — the in-memory values
      // still serve this session, and the next load falls back one further down the
      // cascade. It is never a reason to disturb the host page.
      this.log.error("could not write the flag cache");
    }
  }

  clear(): void {
    const storage = this.storage();
    if (storage === null) return;
    try {
      storage.removeItem(this.envelopeKey);
      storage.removeItem(this.etagKey);
    } catch {
      // Nothing to do; the entries will be overwritten or ignored.
    }
  }

  clearEtag(): void {
    const storage = this.storage();
    if (storage === null) return;
    try {
      storage.removeItem(this.etagKey);
    } catch {
      // Same rule as clear().
    }
  }
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
