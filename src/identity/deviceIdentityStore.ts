import { isWellFormedDeviceId, mintDeviceId } from "./deviceIdentity.js";

/**
 * Durable storage for the device identity.
 *
 * The contract's storage row for the Web
 * (`FortressFlag_Standards/contracts/device-identity.md`, ADR-0014): `localStorage`, key
 * `fortressflag.device.v1`, the bare identifier as the value — origin-scoped by the browser,
 * JS-readable on the page (it is pseudonymous, not secret; the honesty notes in the contract
 * say so plainly rather than pretending to a secure enclave the platform does not have).
 *
 * Mint-then-adopt-on-conflict, browser edition. There is no cross-tab lock; two tabs racing
 * both mint, and convergence is read-back-after-write (whoever wrote while we worked wins on
 * the next read) plus a `storage` event listener ([listen]) that adopts the other tab's
 * value the moment it lands — the loser's identity is discarded, never the winner's, because
 * a device holding two identities bills as two.
 *
 * Every storage access is wrapped: Safari's private mode historically throws on `setItem`,
 * storage can be disabled outright, and SSR has no `localStorage` at all. In all such cases
 * the store mints per-session in memory and carries on — a per-session identity serves flags
 * correctly and errs toward the customer's page working (Founding §8.1).
 */
export const DEVICE_STORAGE_KEY = "fortressflag.device.v1";

/** The identity dependency as the client consumes it, injectable for chaos tests. */
export interface IdentitySource {
  /** The stored-or-minted identity, or null when no identity can be produced at all. */
  identity(): string | null;
  /** The stored identity WITHOUT minting, or null. For the synchronous cache load. */
  peekStored(): string | null;
  reset(): void;
}

/** Resolves `localStorage`, or null where it does not exist or throws on access. */
function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export class DeviceIdentityStore implements IdentitySource {
  /** The per-session fallback when storage is unavailable, and the adopt-target for
   * cross-tab `storage` events. Never preferred over a valid stored value. */
  private inMemory: string | null = null;

  constructor(private readonly storage: () => Storage | null = defaultStorage) {}

  /**
   * The stored identity, or a freshly minted-and-stored one. Malformed stored values are
   * treated as absent rather than trusted. If storage is unavailable the minted identity is
   * kept in memory for the session and returned on every later call — stable within the
   * session, gone with it.
   */
  identity(): string | null {
    const stored = this.read();
    if (stored !== null) {
      this.inMemory = stored;
      return stored;
    }
    if (this.inMemory !== null && this.storageUnavailable()) {
      // Storage is gone but this session already has an identity; keep it stable rather
      // than minting a new device on every call.
      return this.inMemory;
    }
    const minted = this.inMemory ?? mintDeviceId();
    this.write(minted);
    // Read-back-after-write IS the adopt-on-conflict: if another tab's write landed between
    // our read and our write, this returns their value and our mint is the one discarded.
    const adopted = this.read();
    this.inMemory = adopted ?? minted;
    return this.inMemory;
  }

  peekStored(): string | null {
    return this.read();
  }

  /**
   * GDPR erasure for the pseudonymous identifier: delete and re-mint on next use. The
   * documented consequence is honest — this browser will be counted as a new device.
   */
  reset(): void {
    this.inMemory = null;
    const storage = this.storage();
    if (storage === null) return;
    try {
      storage.removeItem(DEVICE_STORAGE_KEY);
    } catch {
      // Storage trouble must not reach the host page; the in-memory copy is already gone.
    }
  }

  /**
   * Installs the cross-tab adoption listener and returns an unsubscribe. When another tab
   * writes a well-formed identity under our key, this tab adopts it — the `storage` event
   * only fires in OTHER tabs, so the writer keeps its own value and every listener converges
   * on it. [onAdopt] lets the client refresh anything that displays the identity.
   */
  listen(onAdopt?: (identity: string) => void): () => void {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
      return () => {};
    }
    const handler = (event: StorageEvent) => {
      if (event.key !== DEVICE_STORAGE_KEY) return;
      const value = event.newValue;
      if (value === null || !isWellFormedDeviceId(value) || value === this.inMemory) return;
      this.inMemory = value;
      if (onAdopt) {
        try {
          onAdopt(value);
        } catch {
          // A hostile or buggy callback must not take the listener down (Founding §8.1).
        }
      }
    };
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener("storage", handler);
    };
  }

  private storageUnavailable(): boolean {
    return this.storage() === null;
  }

  private read(): string | null {
    const storage = this.storage();
    if (storage === null) return null;
    let value: string | null;
    try {
      value = storage.getItem(DEVICE_STORAGE_KEY);
    } catch {
      return null;
    }
    if (value === null) return null;
    return isWellFormedDeviceId(value) ? value : null;
  }

  private write(value: string): void {
    const storage = this.storage();
    if (storage === null) return;
    try {
      storage.setItem(DEVICE_STORAGE_KEY, value);
    } catch {
      // Quota, private mode, disabled storage: the caller degrades to the in-memory copy.
    }
  }
}
