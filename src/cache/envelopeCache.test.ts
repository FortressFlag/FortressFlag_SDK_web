import { describe, expect, it } from "vitest";
import { Environment } from "../configuration.js";
import { Log } from "../support/log.js";
import { LocalStorageEnvelopeCache, MAX_ENVELOPE_BYTES } from "./envelopeCache.js";

const log = new Log("silent", "test");

class FakeStorage implements Storage {
  readonly map = new Map<string, string>();
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

function cacheOn(storage: Storage, sdkKey = "ffc_dev_k", env = Environment.DEVELOPMENT) {
  return new LocalStorageEnvelopeCache(sdkKey, env, log, () => storage);
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("LocalStorageEnvelopeCache", () => {
  it("stores the envelope verbatim and loads it back with its ETag", () => {
    const storage = new FakeStorage();
    const cache = cacheOn(storage);
    const raw = bytes(`{"payload":"abc"}`);
    cache.store(raw, '"etag-1"');
    const loaded = cache.load();
    expect(loaded).not.toBeNull();
    expect(new TextDecoder().decode(loaded?.raw)).toBe(`{"payload":"abc"}`);
    expect(loaded?.etag).toBe('"etag-1"');
  });

  it("namespaces by SDK key and environment — two configurations cannot serve each other", () => {
    const storage = new FakeStorage();
    cacheOn(storage, "ffc_dev_k", Environment.DEVELOPMENT).store(bytes("dev-envelope"), null);
    const other = cacheOn(storage, "ffc_prod_k", Environment.PRODUCTION);
    expect(other.load()).toBeNull();
  });

  it("does not put the SDK key in a storage key readable in a devtools export", () => {
    const storage = new FakeStorage();
    cacheOn(storage, "ffc_dev_supersecretish").store(bytes("x"), null);
    for (const key of storage.map.keys()) {
      expect(key).not.toContain("supersecretish");
      expect(key).toMatch(/^fortressflag\.cache\.[0-9a-f]{8}\./);
    }
  });

  it("refuses to store an oversize envelope and discards an oversize stored value on load", () => {
    const storage = new FakeStorage();
    const cache = cacheOn(storage);
    cache.store(new Uint8Array(MAX_ENVELOPE_BYTES + 1), null);
    expect(cache.load()).toBeNull();

    // Something else wrote junk under our key: discarded AND removed, so the doomed read
    // does not repeat on every load.
    storage.map.set("fortressflag.cache." + firstScope(storage) + ".envelope", "…");
    const big = "x".repeat(MAX_ENVELOPE_BYTES + 1);
    for (const key of [...storage.map.keys()]) storage.map.set(key, big);
    expect(cache.load()).toBeNull();
  });

  it("clearEtag removes only the validator, never the values", () => {
    const storage = new FakeStorage();
    const cache = cacheOn(storage);
    cache.store(bytes("envelope"), '"etag-1"');
    cache.clearEtag();
    const loaded = cache.load();
    expect(loaded?.etag).toBeNull();
    expect(new TextDecoder().decode(loaded?.raw)).toBe("envelope");
  });

  it("clear removes both entries; a throwing storage degrades to null", () => {
    const storage = new FakeStorage();
    const cache = cacheOn(storage);
    cache.store(bytes("envelope"), '"e"');
    cache.clear();
    expect(cache.load()).toBeNull();
    expect(storage.length).toBe(0);

    const throwing = new (class extends FakeStorage {
      override getItem(): string | null {
        throw new Error("disabled");
      }
    })();
    expect(cacheOn(throwing).load()).toBeNull();
  });
});

function firstScope(storage: FakeStorage): string {
  for (const key of storage.map.keys()) {
    const match = /^fortressflag\.cache\.([0-9a-f]{8})\./.exec(key);
    if (match?.[1] !== undefined) return match[1];
  }
  return "00000000";
}
