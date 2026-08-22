import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CachedEnvelope, EnvelopeCache } from "./cache/envelopeCache.js";
import {
  Environment,
  SIGNATURE_DISABLED,
  TrustedKeys,
  signatureRequired,
} from "./configuration.js";
import { resolveConfiguration } from "./configuration.js";
import { resolve } from "./evaluation/resolver.js";
import { FlagClient } from "./flagClient.js";
import type { IdentitySource } from "./identity/deviceIdentityStore.js";
import { SnapshotStore } from "./snapshot.js";
import { Log } from "./support/log.js";
import {
  FIXTURE_DEVICE,
  FIXTURE_NOW_MILLIS,
  envelopeBytes,
  payloadJson,
} from "./testsupport/envelopeFixture.js";
import type { ClientApi, FetchOutcome } from "./transport/clientApi.js";

// The suite that proves the one thing the SDK actually promises: **flagging can fail in any
// way at all, and the host page neither breaks nor sees an error.**
//
// Every other test checks that a specific thing works. These check that nothing breaks when
// everything is wrong at once — which is the state a real browser is in during an outage,
// behind an ad blocker, on a hotel Wi-Fi captive portal, or in the hands of someone actively
// attacking us. Ported from the Android SDK's ChaosTest; the signature-hostile entries defer
// to the fail-closed stub (ADR-0013/0014), so "signed by an attacker" and "signed correctly"
// are equally rejected under a required policy — the safe half of the matrix, and the half
// that exists before backend M4.
//
// One JS-specific invariant rides on top: NO UNHANDLED PROMISE REJECTIONS. A rejected
// promise inside the SDK surfaces in the customer's error tracking as OUR crash (Trap 7),
// so the harness fails on any.

const encoder = new TextEncoder();

/** Every way a response can be wrong, in one list. */
function hostileResponses(): FetchOutcome[] {
  const success = (raw: Uint8Array): FetchOutcome => ({ type: "success", raw, etag: null });
  const failure = (failure: FetchOutcome & { type: "failure" }): FetchOutcome => failure;
  void failure;
  return [
    // Transport-level failures
    { type: "failure", failure: { code: "offline" } },
    { type: "failure", failure: { code: "timedOut" } },
    { type: "failure", failure: { code: "cancelled" } },
    { type: "failure", failure: { code: "unauthorized" } },
    { type: "failure", failure: { code: "rateLimited", retryAfterSeconds: null } },
    { type: "failure", failure: { code: "rateLimited", retryAfterSeconds: 31_536_000 } },
    { type: "failure", failure: { code: "serverError", status: 500 } },
    { type: "failure", failure: { code: "serverError", status: 503 } },
    { type: "failure", failure: { code: "unexpectedStatus", status: 418 } },
    { type: "failure", failure: { code: "responseTooLarge" } },
    { type: "failure", failure: { code: "other", description: "something nobody anticipated" } },
    // Bodies that are not envelopes at all
    success(new Uint8Array(0)),
    success(encoder.encode("<html>captive portal</html>")),
    success(encoder.encode("{")),
    success(encoder.encode("null")),
    success(new Uint8Array(4096)),
    // Envelopes that are structurally valid but must not be trusted
    success(envelopeBytes(payloadJson({ environment: "prod" }))),
    success(envelopeBytes(payloadJson({ device: "dev_BBBBBBBBBBBBBBBBBBAAAA" }))),
    success(envelopeBytes(payloadJson({ version: 99 }))),
    success(
      envelopeBytes(
        payloadJson({ issuedAt: "2026-08-18T08:00:00Z", expiresAt: "2026-08-18T08:30:00Z" }),
      ),
    ),
    success(envelopeBytes(payloadJson({ issuedAt: "2026-08-19T10:00:00Z" }))),
    // Value-union violations: null, object, array
    success(envelopeBytes(payloadJson({ flagsJson: `{"alpha":null}` }))),
    success(envelopeBytes(payloadJson({ flagsJson: `{"alpha":{"nested":true}}` }))),
    success(envelopeBytes(payloadJson({ flagsJson: `{"alpha":[1,2]}` }))),
    // Truncation, the classic mid-flight failure
    success(envelopeBytes().slice(0, 20)),
    // A 304 with nothing necessarily cached behind it
    { type: "notModified" },
  ];
}

class SeededCache implements EnvelopeCache {
  contents: Uint8Array | null;
  stores = 0;
  constructor(seed: Uint8Array | null = null) {
    this.contents = seed;
  }
  load(): CachedEnvelope | null {
    return this.contents === null ? null : { raw: this.contents, etag: null };
  }
  store(raw: Uint8Array): void {
    this.contents = raw;
    this.stores += 1;
  }
  clear(): void {
    this.contents = null;
  }
  clearEtag(): void {}
}

class ScriptedApi implements ClientApi {
  index = 0;
  constructor(private readonly script: FetchOutcome[]) {}
  fetchFlags(): Promise<FetchOutcome> {
    const outcome = this.script[this.index % this.script.length] ?? { type: "notModified" };
    this.index += 1;
    return Promise.resolve(outcome);
  }
}

class StubIdentity implements IdentitySource {
  constructor(private readonly value: string | null) {}
  identity(): string | null {
    return this.value;
  }
  peekStored(): string | null {
    return this.value;
  }
  reset(): void {}
}

function client(
  api: ClientApi,
  cache: EnvelopeCache,
  store: SnapshotStore,
  options: {
    identity?: IdentitySource;
    notify?: (changed: ReadonlySet<string>) => void;
    signaturePolicy?: ReturnType<typeof signatureRequired>;
  } = {},
) {
  return new FlagClient({
    configuration: resolveConfiguration({
      sdkKey: "ffc_dev_k",
      environment: Environment.DEVELOPMENT,
      signaturePolicy: options.signaturePolicy ?? SIGNATURE_DISABLED,
    }),
    identity: options.identity ?? new StubIdentity(FIXTURE_DEVICE),
    api,
    cache,
    store,
    log: new Log("silent", "chaos"),
    builtinTags: {},
    now: () => FIXTURE_NOW_MILLIS,
    random: () => 0,
    notify: options.notify ?? (() => {}),
  });
}

// The unhandled-rejection harness (Trap 7) — a rejection that escapes the SDK during a
// chaos run fails the suite.
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(async () => {
  // Give any stray rejection a microtask turn to surface before we assert.
  await new Promise((r) => setTimeout(r, 0));
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled, "the SDK leaked an unhandled promise rejection").toEqual([]);
});

describe("chaos", () => {
  it("a browser holding a good value never loses it, and the cache bytes stay untouched", async () => {
    const good = envelopeBytes(payloadJson({ flagsJson: `{"alpha":true,"beta":false}` }));
    const cache = new SeededCache(good);
    const store = new SnapshotStore();
    const hostile = hostileResponses();
    const flagClient = client(new ScriptedApi(hostile), cache, store);

    flagClient.loadCacheIntoStore();

    for (let i = 0; i < hostile.length; i++) {
      // Whatever happened, it was reported as an outcome and not raised.
      const outcome = await flagClient.refresh();
      expect(outcome.type).not.toBe("notStarted");

      // And the browser still answers correctly, from the value it recorded.
      const snapshot = store.current;
      const alpha = resolve("alpha", snapshot.fresh, snapshot.cached, null);
      expect(alpha.value).toEqual({ kind: "boolean", value: true });
      expect(alpha.source).toBe("cached");
    }

    // The cache bytes are exactly what they were. Nothing hostile rewrote them.
    expect(cache.stores).toBe(0);
    expect([...(cache.contents ?? [])]).toEqual([...good]);
  });

  it("a cold browser answers false forever without breaking", async () => {
    const store = new SnapshotStore();
    const hostile = hostileResponses();
    const flagClient = client(new ScriptedApi(hostile), new SeededCache(), store);

    for (let i = 0; i < hostile.length; i++) {
      await flagClient.refresh();
      const snapshot = store.current;
      const result = resolve("anything", snapshot.fresh, snapshot.cached, null);
      expect(result.value).toEqual({ kind: "boolean", value: false });
      expect(result.source).toBe("safeDefault");
    }
  });

  it("signature-hostile envelopes all reject under required, cache untouched", async () => {
    // Under required with a trust store, every signature shape must reject-to-cache:
    // absent, malformed, unknown key, wrong algorithm — and, until M4 supplies the
    // primitive, even a plausible one (the stub can only reject; it can never accept a
    // forgery).
    const good = envelopeBytes();
    const cache = new SeededCache(good);
    const store = new SnapshotStore();
    const signedShapes: FetchOutcome[] = [
      { type: "success", raw: envelopeBytes(payloadJson()), etag: null },
      { type: "success", raw: envelopeBytes(payloadJson(), "garbage"), etag: null },
      {
        type: "success",
        raw: envelopeBytes(payloadJson(), "ed25519:unknown-key:AAAA"),
        etag: null,
      },
      { type: "success", raw: envelopeBytes(payloadJson(), "p256:k1:AAAA"), etag: null },
      { type: "success", raw: envelopeBytes(payloadJson(), "ed25519:k1:AAAA"), etag: null },
    ];
    const flagClient = client(new ScriptedApi(signedShapes), cache, store, {
      signaturePolicy: signatureRequired(new TrustedKeys({ k1: new Uint8Array(32) })),
    });
    flagClient.loadCacheIntoStore();

    for (let i = 0; i < signedShapes.length; i++) {
      const outcome = await flagClient.refresh();
      expect(outcome).toEqual({ type: "failed", failure: "rejectedPayload" });
    }
    expect(cache.stores).toBe(0);
  });

  it("identity storage unavailable degrades — it does not fail", async () => {
    const store = new SnapshotStore();
    const cache = new SeededCache(envelopeBytes());
    const flagClient = client(
      new ScriptedApi([{ type: "failure", failure: { code: "offline" } }]),
      cache,
      store,
      { identity: new StubIdentity(null) },
    );

    // No identity, so the device check is skipped and the cache still serves — the whole
    // point of making the check optional.
    flagClient.loadCacheIntoStore();
    expect(store.current.cached?.get("dark-mode")).toEqual({ kind: "boolean", value: true });

    const outcome = await flagClient.refresh();
    expect(outcome.type).toBe("failed");
    expect(store.current.cached?.get("dark-mode")).toEqual({ kind: "boolean", value: true });
  });

  it("a hostile change handler does not take the SDK with it", async () => {
    // Customers write these handlers. One that recurses into the SDK or throws must not
    // break the refresh or reach the host page — the broadcast swallows their exceptions.
    const store = new SnapshotStore();
    let calls = 0;
    const flagClient = client(
      new ScriptedApi([{ type: "success", raw: envelopeBytes(), etag: null }]),
      new SeededCache(),
      store,
      {
        notify: () => {
          calls += 1;
          // Re-entrant read from inside the handler.
          void store.current;
          throw new Error("hostile handler");
        },
      },
    );

    const outcome = await flagClient.refresh();
    expect(outcome.type).toBe("updated");
    expect(calls).toBe(1);
  });
});
