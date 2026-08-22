import { describe, expect, it } from "vitest";
import { isWellFormedDeviceId } from "./deviceIdentity.js";
import { DEVICE_STORAGE_KEY, DeviceIdentityStore } from "./deviceIdentityStore.js";

// The degradation paths, driven with injected storage doubles. These are exactly the paths a
// REAL browser cannot be asked to produce on demand (a storage API that throws, storage that
// vanishes mid-session), which is why they are unit tests — the real-browser lane
// (deviceIdentityStore.browser.test.ts) covers what only a real browser can prove.
class FakeStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

class ThrowingStorage extends FakeStorage {
  override getItem(): string | null {
    throw new Error("storage disabled");
  }
  override setItem(): void {
    throw new Error("storage disabled");
  }
  override removeItem(): void {
    throw new Error("storage disabled");
  }
}

describe("DeviceIdentityStore", () => {
  it("mints, stores, and returns the same identity thereafter", () => {
    const storage = new FakeStorage();
    const store = new DeviceIdentityStore(() => storage);
    const first = store.identity();
    expect(first).not.toBeNull();
    expect(isWellFormedDeviceId(first ?? "")).toBe(true);
    expect(storage.getItem(DEVICE_STORAGE_KEY)).toBe(first);
    expect(store.identity()).toBe(first);
  });

  it("adopts a valid stored identity instead of minting", () => {
    const storage = new FakeStorage();
    storage.setItem(DEVICE_STORAGE_KEY, "dev_AAAAAAAAAAAAAAAAAAAAAA");
    const store = new DeviceIdentityStore(() => storage);
    expect(store.identity()).toBe("dev_AAAAAAAAAAAAAAAAAAAAAA");
  });

  it("treats a malformed stored value as absent, never trusts it", () => {
    const storage = new FakeStorage();
    storage.setItem(DEVICE_STORAGE_KEY, "device_junk!!");
    const store = new DeviceIdentityStore(() => storage);
    const minted = store.identity();
    expect(minted).not.toBe("device_junk!!");
    expect(isWellFormedDeviceId(minted ?? "")).toBe(true);
    expect(storage.getItem(DEVICE_STORAGE_KEY)).toBe(minted);
  });

  it("peekStored never mints", () => {
    const storage = new FakeStorage();
    const store = new DeviceIdentityStore(() => storage);
    expect(store.peekStored()).toBeNull();
    expect(storage.getItem(DEVICE_STORAGE_KEY)).toBeNull();
  });

  it("degrades to a stable per-session identity when storage throws", () => {
    const store = new DeviceIdentityStore(() => new ThrowingStorage());
    const first = store.identity();
    expect(first).not.toBeNull();
    expect(isWellFormedDeviceId(first ?? "")).toBe(true);
    // Stable within the session: a new device per call would bill one browser as many.
    expect(store.identity()).toBe(first);
  });

  it("degrades to a stable per-session identity when storage is absent (SSR)", () => {
    const store = new DeviceIdentityStore(() => null);
    const first = store.identity();
    expect(first).not.toBeNull();
    expect(store.identity()).toBe(first);
  });

  it("adopts the concurrent winner's value on read-back-after-write", () => {
    // Simulates the two-tab race: our read misses, we mint and write, but the other tab's
    // write lands after ours — so the read-back sees theirs. The loser must adopt, never
    // overwrite (the device-identity contract: a device holding two identities bills as two).
    const winner = "dev_BBBBBBBBBBBBBBBBBBAAAA";
    class RacingStorage extends FakeStorage {
      override setItem(key: string, value: string): void {
        super.setItem(key, value);
        // The other tab wins immediately after our write.
        super.setItem(key, winner);
      }
    }
    const storage = new RacingStorage();
    const store = new DeviceIdentityStore(() => storage);
    expect(store.identity()).toBe(winner);
  });

  it("reset removes the stored identity and the next use mints a new one", () => {
    const storage = new FakeStorage();
    const store = new DeviceIdentityStore(() => storage);
    const first = store.identity();
    store.reset();
    expect(storage.getItem(DEVICE_STORAGE_KEY)).toBeNull();
    const second = store.identity();
    expect(second).not.toBe(first);
    expect(isWellFormedDeviceId(second ?? "")).toBe(true);
  });
});
