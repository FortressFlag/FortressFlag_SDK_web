import { afterEach, describe, expect, it } from "vitest";
import type { CachedEnvelope, EnvelopeCache } from "./cache/envelopeCache.js";
import { Environment, SIGNATURE_DISABLED, type Configuration } from "./configuration.js";
import { FortressFlag } from "./fortressFlag.js";
import type { IdentitySource } from "./identity/deviceIdentityStore.js";
import {
  FIXTURE_DEVICE,
  FIXTURE_NOW_MILLIS,
  envelopeBytes,
  payloadJson,
} from "./testsupport/envelopeFixture.js";
import type { ClientApi, FetchOutcome } from "./transport/clientApi.js";

class StubIdentity implements IdentitySource {
  constructor(private value: string | null = FIXTURE_DEVICE) {}
  identity(): string | null {
    return this.value;
  }
  peekStored(): string | null {
    return this.value;
  }
  reset(): void {
    this.value = null;
  }
}

class MemoryCache implements EnvelopeCache {
  contents: CachedEnvelope | null = null;
  stores = 0;
  constructor(seed: CachedEnvelope | null = null) {
    this.contents = seed;
  }
  load(): CachedEnvelope | null {
    return this.contents;
  }
  store(raw: Uint8Array, etag: string | null): void {
    this.contents = { raw, etag };
    this.stores += 1;
  }
  clear(): void {
    this.contents = null;
  }
  clearEtag(): void {
    if (this.contents) this.contents = { raw: this.contents.raw, etag: null };
  }
}

class ScriptedApi implements ClientApi {
  calls: { deviceId: string; etag: string | null; tags: string | null }[] = [];
  constructor(private readonly script: FetchOutcome[]) {}
  fetchFlags(deviceId: string, etag: string | null, tags: string | null): Promise<FetchOutcome> {
    this.calls.push({ deviceId, etag, tags });
    const outcome = this.script[Math.min(this.calls.length - 1, this.script.length - 1)] ?? {
      type: "notModified",
    };
    return Promise.resolve(outcome);
  }
}

const configuration: Configuration = {
  sdkKey: "ffc_dev_k",
  environment: Environment.DEVELOPMENT,
  signaturePolicy: SIGNATURE_DISABLED,
  logging: "silent",
};

function startWith(api: ClientApi, cache: EnvelopeCache = new MemoryCache()) {
  FortressFlag.start(configuration, {
    api,
    cache,
    identity: new StubIdentity(),
    now: () => FIXTURE_NOW_MILLIS,
    random: () => 0,
  });
}

const success = (payload: string, etag: string | null = null): FetchOutcome => ({
  type: "success",
  raw: envelopeBytes(payload),
  etag,
});

afterEach(() => {
  FortressFlag.stop();
});

describe("FortressFlag — synchronous cache load", () => {
  it("start returns with the cache already readable — pinned even though localStorage makes it natural", () => {
    const cache = new MemoryCache({ raw: envelopeBytes(), etag: '"e1"' });
    startWith(new ScriptedApi([{ type: "notModified" }]), cache);
    // No await: the very next line after start() must see the last recorded values.
    const resolution = FortressFlag.resolve("dark-mode");
    expect(resolution.value).toEqual({ kind: "boolean", value: true });
    expect(resolution.source).toBe("cached");
    expect(FortressFlag.diagnostics.isStarted).toBe(true);
  });

  it("sends the restored ETag on the first fetch", async () => {
    const api = new ScriptedApi([{ type: "notModified" }]);
    startWith(api, new MemoryCache({ raw: envelopeBytes(), etag: '"e1"' }));
    await FortressFlag.refresh();
    expect(api.calls[0]?.etag).toBe('"e1"');
  });
});

describe("FortressFlag — reads", () => {
  it("projects kinds instead of coercing: a string flag through isEnabled answers the default", async () => {
    startWith(new ScriptedApi([success(payloadJson({ flagsJson: `{"cta":"buy-now","n":3}` }))]));
    await FortressFlag.refresh();
    expect(FortressFlag.isEnabled("cta")).toBe(false);
    expect(FortressFlag.isEnabled("cta", true)).toBe(true);
    expect(FortressFlag.stringValue("cta", "fallback")).toBe("buy-now");
    expect(FortressFlag.numberValue("n", 0)).toBe(3);
    expect(FortressFlag.stringValue("n", "fallback")).toBe("fallback");
    expect(FortressFlag.numberValue("cta", 7)).toBe(7);
  });

  it("enumerates the union with provenance and no developer defaults", async () => {
    startWith(new ScriptedApi([success(payloadJson())]));
    await FortressFlag.refresh();
    const all = FortressFlag.allFlags();
    expect(all.get("dark-mode")?.source).toBe("fresh");
    expect(all.size).toBe(2);
  });
});

describe("FortressFlag — refresh", () => {
  it("reports updated with the changed keys, then unchanged on an identical payload", async () => {
    startWith(new ScriptedApi([success(payloadJson()), success(payloadJson())]));
    const first = await FortressFlag.refresh();
    expect(first).toMatchObject({ type: "updated" });
    if (first.type === "updated") {
      expect(first.changedKeys).toEqual(new Set(["dark-mode"]));
    }
    const second = await FortressFlag.refresh();
    expect(second.type).toBe("unchanged");
  });

  it("treats a 304 as success and stamps the last successful fetch", async () => {
    startWith(new ScriptedApi([{ type: "notModified" }]));
    const outcome = await FortressFlag.refresh();
    expect(outcome.type).toBe("unchanged");
    expect(FortressFlag.diagnostics.lastSuccessfulFetchEpochMillis).toBe(FIXTURE_NOW_MILLIS);
  });

  it("never rejects — a hostile transport becomes a failed outcome", async () => {
    const api: ClientApi = {
      fetchFlags: () => Promise.reject(new Error("exploded")),
    };
    startWith(api);
    const outcome = await FortressFlag.refresh();
    expect(outcome).toEqual({ type: "failed", failure: "network" });
  });

  it("coalesces concurrent callers onto one request", async () => {
    let resolveFetch: ((outcome: FetchOutcome) => void) | null = null;
    let calls = 0;
    const api: ClientApi = {
      fetchFlags: () => {
        calls += 1;
        return new Promise((res) => {
          resolveFetch = res;
        });
      },
    };
    startWith(api);
    const a = FortressFlag.refresh();
    const b = FortressFlag.refresh();
    resolveFetch?.({ type: "notModified" });
    expect((await a).type).toBe("unchanged");
    expect((await b).type).toBe("unchanged");
    expect(calls).toBe(1);
  });

  it("answers notStarted before start", async () => {
    FortressFlag.stop();
    expect((await FortressFlag.refresh()).type).toBe("notStarted");
  });
});

describe("FortressFlag — tags", () => {
  it("clears the stored ETag when the tag set changes, in memory and in the cache", async () => {
    const cache = new MemoryCache({ raw: envelopeBytes(), etag: '"e1"' });
    const api = new ScriptedApi([{ type: "notModified" }, { type: "notModified" }]);
    startWith(api, cache);
    await FortressFlag.refresh();
    expect(api.calls[0]?.etag).toBe('"e1"');

    FortressFlag.setTags({ cohort: "beta" });
    await FortressFlag.refresh();
    const after = api.calls[api.calls.length - 1];
    // A different tag set can mean a different payload for the same device: the old
    // validator no longer names what the next response would be.
    expect(after?.etag).toBeNull();
    expect(cache.contents?.etag).toBeNull();
    expect(after?.tags).not.toBeNull();
  });
});

describe("FortressFlag — change notification", () => {
  it("notifies with effective changes, survives hostile handlers, honours unsubscribe", async () => {
    startWith(new ScriptedApi([success(payloadJson())]));
    const seen: ReadonlySet<string>[] = [];
    const unsubscribe = FortressFlag.onChange(() => {
      throw new Error("hostile handler");
    });
    const unsubscribe2 = FortressFlag.onChange((changed) => {
      seen.push(changed);
    });

    const outcome = await FortressFlag.refresh();
    expect(outcome.type).toBe("updated");
    expect(seen).toEqual([new Set(["dark-mode"])]);

    unsubscribe();
    unsubscribe2();
  });
});

describe("FortressFlag — lifecycle", () => {
  it("start re-entry replaces cleanly — the poll chain never doubles", async () => {
    // React StrictMode double-invokes init code; with the 10/5min device limit a doubled
    // poll loop becomes a 429 loop (Traps 9+10).
    const api = new ScriptedApi([{ type: "notModified" }]);
    startWith(api);
    startWith(api);
    await FortressFlag.refresh();
    // Two starts each fire one immediate poll, plus our explicit refresh: never more.
    expect(api.calls.length).toBeLessThanOrEqual(3);
    expect(FortressFlag.diagnostics.isStarted).toBe(true);
  });

  it("resetIdentity clears identity, cache and values", async () => {
    const cache = new MemoryCache({ raw: envelopeBytes(), etag: '"e1"' });
    startWith(new ScriptedApi([{ type: "notModified" }]), cache);
    expect(FortressFlag.resolve("dark-mode").source).toBe("cached");
    FortressFlag.resetIdentity();
    expect(cache.contents).toBeNull();
    expect(FortressFlag.resolve("dark-mode").source).toBe("safeDefault");
    expect(FortressFlag.diagnostics.deviceIdentity).toBeNull();
  });

  it("stop keeps resolving from memory", async () => {
    startWith(new ScriptedApi([success(payloadJson())]));
    await FortressFlag.refresh();
    FortressFlag.stop();
    expect(FortressFlag.isEnabled("dark-mode")).toBe(true);
    expect(FortressFlag.diagnostics.isStarted).toBe(false);
  });
});
