import { afterEach, describe, expect, it } from "vitest";
import { Environment } from "../configuration.js";
import { Log } from "../support/log.js";
import { LocalStorageEnvelopeCache } from "./envelopeCache.js";

// The real-browser half of the cache suite: REAL localStorage round-trips, including
// non-ASCII envelope bytes surviving the string round-trip — the property the unit fake
// cannot prove (jsdom's localStorage is a polite fake; Trap 6).
describe("LocalStorageEnvelopeCache (real browser)", () => {
  const log = new Log("silent", "test");
  const cache = () => new LocalStorageEnvelopeCache("ffc_dev_k", Environment.DEVELOPMENT, log);

  afterEach(() => {
    cache().clear();
  });

  it("persists an envelope and its ETag across cache instances", () => {
    const raw = new TextEncoder().encode(`{"payload":"abc","note":"héllo 🚀"}`);
    cache().store(raw, '"etag-9"');

    const loaded = cache().load();
    expect(loaded).not.toBeNull();
    expect([...(loaded?.raw ?? [])]).toEqual([...raw]);
    expect(loaded?.etag).toBe('"etag-9"');
  });

  it("clear removes both entries from real storage", () => {
    cache().store(new TextEncoder().encode("x"), '"e"');
    cache().clear();
    expect(cache().load()).toBeNull();
    for (let i = 0; i < localStorage.length; i++) {
      expect(localStorage.key(i)).not.toMatch(/^fortressflag\.cache\./);
    }
  });
});
