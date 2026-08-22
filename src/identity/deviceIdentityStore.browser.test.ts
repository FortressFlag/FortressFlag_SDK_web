import { afterEach, describe, expect, it } from "vitest";
import { isWellFormedDeviceId } from "./deviceIdentity.js";
import { DEVICE_STORAGE_KEY, DeviceIdentityStore } from "./deviceIdentityStore.js";

// The real-browser half of the identity suite: REAL localStorage persistence and the real
// `storage`-event wiring. The degradation paths (throwing storage, SSR) live in the unit
// suite with injected doubles — a real browser cannot be asked to throw on demand.
describe("DeviceIdentityStore (real browser)", () => {
  afterEach(() => {
    localStorage.removeItem(DEVICE_STORAGE_KEY);
  });

  it("persists a minted identity in real localStorage and re-adopts it", () => {
    const store = new DeviceIdentityStore();
    const first = store.identity();
    expect(first).not.toBeNull();
    expect(isWellFormedDeviceId(first ?? "")).toBe(true);
    expect(localStorage.getItem(DEVICE_STORAGE_KEY)).toBe(first);

    // A second store (a page reload, another script) adopts, never re-mints.
    expect(new DeviceIdentityStore().identity()).toBe(first);
  });

  it("mints sim_ under automation — this test IS the proof", () => {
    // Playwright drives this browser, so navigator.webdriver is true and the minted
    // identity must carry the sim_ prefix (ADR-0014): the test lane demonstrates the exact
    // mechanism that keeps customers' E2E suites unbilled.
    const minted = new DeviceIdentityStore().identity();
    expect(minted?.startsWith("sim_"), minted ?? "").toBe(true);
  });

  it("replaces malformed junk instead of trusting it", () => {
    localStorage.setItem(DEVICE_STORAGE_KEY, "not-an-identity");
    const minted = new DeviceIdentityStore().identity();
    expect(minted).not.toBe("not-an-identity");
    expect(isWellFormedDeviceId(minted ?? "")).toBe(true);
    expect(localStorage.getItem(DEVICE_STORAGE_KEY)).toBe(minted);
  });

  it("reset removes the stored key", () => {
    const store = new DeviceIdentityStore();
    store.identity();
    store.reset();
    expect(localStorage.getItem(DEVICE_STORAGE_KEY)).toBeNull();
  });

  it("adopts another tab's value via the storage event", () => {
    const store = new DeviceIdentityStore();
    const mine = store.identity();
    const theirs = "dev_BBBBBBBBBBBBBBBBBBAAAA";
    expect(mine).not.toBe(theirs);

    let adopted: string | null = null;
    const unsubscribe = store.listen((value) => {
      adopted = value;
    });

    // A real cross-tab event needs a second browsing context; dispatching the event tests
    // the listener wiring — the browser guarantees delivery, we guarantee adoption.
    window.dispatchEvent(
      new StorageEvent("storage", { key: DEVICE_STORAGE_KEY, newValue: theirs }),
    );

    expect(adopted).toBe(theirs);
    unsubscribe();

    // After unsubscribe, further events are ignored.
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: DEVICE_STORAGE_KEY,
        newValue: "dev_CCCCCCCCCCCCCCCCCCAAAA",
      }),
    );
    expect(adopted).toBe(theirs);
  });

  it("ignores malformed values arriving via the storage event", () => {
    const store = new DeviceIdentityStore();
    store.identity();
    let adopted: string | null = null;
    const unsubscribe = store.listen((value) => {
      adopted = value;
    });
    window.dispatchEvent(
      new StorageEvent("storage", { key: DEVICE_STORAGE_KEY, newValue: "garbage!!" }),
    );
    expect(adopted).toBeNull();
    unsubscribe();
  });
});
