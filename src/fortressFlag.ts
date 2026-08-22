import type { Configuration } from "./configuration.js";
import { resolveConfiguration, validateConfiguration } from "./configuration.js";
import { LocalStorageEnvelopeCache } from "./cache/envelopeCache.js";
import type { EnvelopeCache } from "./cache/envelopeCache.js";
import { resolve as resolveCascade, resolveAll } from "./evaluation/resolver.js";
import { FlagClient } from "./flagClient.js";
import type { FlagValue } from "./flagValue.js";
import { DeviceIdentityStore } from "./identity/deviceIdentityStore.js";
import type { IdentitySource } from "./identity/deviceIdentityStore.js";
import type { Diagnostics, RefreshOutcome, Resolution } from "./resolution.js";
import { SnapshotStore } from "./snapshot.js";
import { Log } from "./support/log.js";
import { builtinTags } from "./tags/builtinTags.js";
import type { Backoff, RandomInRange } from "./transport/backoff.js";
import type { ClientApi } from "./transport/clientApi.js";
import { HttpClientApi } from "./transport/httpClientApi.js";

/** Unregisters a change handler. Safe to call more than once. */
export type Unsubscribe = () => void;

const snapshots = new SnapshotStore();
let client: FlagClient | null = null;
let identityUnlisten: (() => void) | null = null;
let visibilityHandler: (() => void) | null = null;
const listeners = new Map<number, (changed: ReadonlySet<string>) => void>();
let nextListenerId = 0;

/** Everything injectable, for the test suite and the chaos harness. */
export interface StartOverrides {
  identity?: IdentitySource;
  api?: ClientApi;
  cache?: EnvelopeCache;
  builtinTags?: Readonly<Record<string, string>>;
  backoff?: Backoff;
  now?: () => number;
  random?: RandomInRange;
}

/**
 * FortressFlag's web client SDK.
 *
 * ## The promise
 *
 * **No call in this API throws, and no promise from it rejects.** A FortressFlag outage, a
 * dead network, an ad blocker, a revoked key, a hostile Wi-Fi portal, a corrupt cache — all
 * of them resolve to a flag value and none of them reach your code as an error. That is the
 * product: if flagging can break a page, it is worse than no flagging at all (Founding §8.1).
 *
 * ## What this is not
 *
 * **Flag values are not a security boundary.** They are evaluated in a browser the end user
 * controls; anyone with devtools open can observe any flag. Use flags to decide what to
 * show, never to decide what someone is entitled to.
 *
 * ## Usage
 *
 * ```ts
 * FortressFlag.start({ sdkKey: "ffc_prod_…", environment: Environment.PRODUCTION });
 * if (FortressFlag.isEnabled("new-checkout")) { … }
 * ```
 */
export const FortressFlag = {
  /**
   * Starts the SDK. Safe to call during page setup.
   *
   * Returns as soon as the durable cache has been read (synchronously — `localStorage`),
   * so a flag read on the next line already sees the last values this browser had.
   * Everything else — identity, network, polling — happens in the background. Calling it a
   * second time replaces the configuration cleanly: the old poll chain is cancelled, never
   * doubled (React StrictMode double-invoke and hot module reload both re-run init code,
   * and a doubled poll loop against the per-device rate limit becomes a 429 loop). Invalid
   * configuration is logged, never fatal: a page that ships with a typo'd key still loads,
   * it just serves defaults.
   */
  start(configuration: Configuration, overrides: StartOverrides = {}): void {
    const resolved = resolveConfiguration(configuration);
    const log = new Log(resolved.logging, "client");
    for (const problem of validateConfiguration(resolved)) {
      log.warning(`configuration problem — ${problem.message}`);
    }

    const identity = overrides.identity ?? new DeviceIdentityStore();
    const api =
      overrides.api ?? new HttpClientApi(resolved, new Log(resolved.logging, "transport"));
    const cache =
      overrides.cache ??
      new LocalStorageEnvelopeCache(
        resolved.sdkKey,
        resolved.environment,
        new Log(resolved.logging, "cache"),
      );

    // Replace cleanly: cancel the previous poll chain and page listeners BEFORE the new
    // client exists, so no interleaving can double-poll (Trap: start() re-entry).
    teardown();
    snapshots.reset();

    const newClient = new FlagClient({
      configuration: resolved,
      identity,
      api,
      cache,
      store: snapshots,
      log,
      builtinTags: overrides.builtinTags ?? builtinTags(),
      ...(overrides.backoff !== undefined ? { backoff: overrides.backoff } : {}),
      ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      ...(overrides.random !== undefined ? { random: overrides.random } : {}),
      notify: broadcast,
    });
    client = newClient;

    // Synchronous, before this function returns — see FlagClient.loadCacheIntoStore.
    const restoredEtag = newClient.loadCacheIntoStore();

    // Marked started here rather than inside the client, so diagnostics.isStarted is true
    // the instant start returns.
    snapshots.update((s) => ({ ...s, isStarted: true }));

    // Cross-tab identity adoption: another tab minting first must win everywhere.
    if (identity instanceof DeviceIdentityStore) {
      identityUnlisten = identity.listen((adopted) => {
        snapshots.update((s) => ({ ...s, deviceId: adopted }));
      });
    }

    // Background tabs throttle timers to ≥1/minute, so the poll cadence is best-effort in
    // hidden tabs; this hook is the designed compensation — a returning user refreshes
    // immediately when the data is older than one interval (the web analog of iOS's
    // refresh-on-foreground guidance).
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      const handler = () => {
        if (document.visibilityState !== "visible") return;
        const current = client;
        if (current !== null && current.isStaleNow()) void current.refresh();
      };
      document.addEventListener("visibilitychange", handler);
      visibilityHandler = handler;
    }

    newClient.start(restoredEtag);
  },

  /** Stops polling. Values already resolved keep resolving from memory and cache. */
  stop(): void {
    teardown();
    snapshots.update((s) => ({ ...s, isStarted: false }));
  },

  /**
   * Whether [key] is on for this browser. Synchronous and allocation-light: it reads an
   * in-memory snapshot — no I/O, safe to call from a render pass.
   *
   * The resolution order is fixed (Founding §8.4):
   * 1. the most recent value fetched from FortressFlag
   * 2. the last value this browser recorded, from the durable cache
   * 3. [defaultValue], if you supplied one
   * 4. `false`
   *
   * Note step 2 before step 3: a value this browser actually received always beats a
   * compiled-in default, however old it is. [defaultValue] answers "what if this browser
   * has never heard anything about this flag at all?" — not "what if we are offline?".
   *
   * The kind projection (contract v2): a string or number flag read through this boolean
   * API resolves to the caller's default, else `false` — fail-safe, never a coercion,
   * never an error.
   */
  isEnabled(key: string, defaultValue?: boolean): boolean {
    const resolution = this.resolve(key, defaultValue);
    return resolution.value.kind === "boolean" ? resolution.value.value : (defaultValue ?? false);
  },

  /**
   * The value of a STRING flag, or [defaultValue] when the flag is unknown, has no served
   * value yet, or is not a string kind. Never throws; the cascade is [isEnabled]'s exactly.
   */
  stringValue(key: string, defaultValue: string): string {
    const snapshot = snapshots.current;
    const resolution = resolveCascade(key, snapshot.fresh, snapshot.cached, {
      kind: "string",
      value: defaultValue,
    });
    return resolution.value.kind === "string" ? resolution.value.value : defaultValue;
  },

  /** The value of a NUMBER flag, or [defaultValue] under exactly [stringValue]'s rules.
   * Numbers are float64 on the wire, as the server serves them. */
  numberValue(key: string, defaultValue: number): number {
    const snapshot = snapshots.current;
    const resolution = resolveCascade(key, snapshot.fresh, snapshot.cached, {
      kind: "number",
      value: defaultValue,
    });
    return resolution.value.kind === "number" ? resolution.value.value : defaultValue;
  },

  /** As [isEnabled], but reports the value union and where it came from. For diagnostics
   * and for tests that want to assert on more than the projection. */
  resolve(key: string, defaultValue?: boolean): Resolution {
    const snapshot = snapshots.current;
    const developerDefault: FlagValue | null =
      defaultValue === undefined ? null : { kind: "boolean", value: defaultValue };
    return resolveCascade(key, snapshot.fresh, snapshot.cached, developerDefault);
  },

  /**
   * Every flag this browser has received, with each key's effective value and provenance —
   * the union of the most recent payload and the durable cache, resolved through exactly
   * the same cascade as [isEnabled]. Sources are therefore always "fresh" or "cached": a
   * key the browser has never heard of is not in the map at all.
   *
   * This enumerates only this browser's own payload — flag keys the server already sends
   * this device, which are visible in the network tab in any case. It exposes no other
   * device's data and nothing the management API holds.
   */
  allFlags(): Map<string, Resolution> {
    const snapshot = snapshots.current;
    return resolveAll(snapshot.fresh, snapshot.cached);
  },

  /**
   * Fetches values now, in addition to the background poll. The promise NEVER rejects —
   * a rejected promise is a throw to the caller. Concurrent calls share one request. A
   * good moment to call this is when your app regains focus; a bad one is in a loop.
   */
  refresh(): Promise<RefreshOutcome> {
    const current = client;
    if (current === null) return Promise.resolve({ type: "notStarted" });
    return current.refresh();
  },

  /**
   * Replaces the custom tag set and fetches with it immediately. Never throws. The
   * replacement is whole-set: tags you omit stop being sent, and the built-in tags are
   * always sent and cannot be overridden. Until the refresh answers, flags keep resolving
   * from the current values — a tag change is a reason to re-ask, not a reason to forget.
   */
  setTags(tags: Readonly<Record<string, string>>): void {
    const current = client;
    if (current === null) return;
    current.setTags(tags);
    void current.refresh();
  },

  /**
   * Registers a handler for flag changes, returning an unsubscribe function. The handler
   * is called with the keys whose *effective* value changed — safe to drive UI updates
   * from directly.
   */
  onChange(handler: (changed: ReadonlySet<string>) => void): Unsubscribe {
    nextListenerId += 1;
    const id = nextListenerId;
    listeners.set(id, handler);
    return () => {
      listeners.delete(id);
    };
  },

  /**
   * Deletes this browser's identity and every cached value, then mints a fresh identity on
   * next use. A real erasure path, not a flag (Founding §7.3). The old identifier is
   * unrecoverable afterwards — which is the point, and also means this browser will be
   * counted as a new device for billing.
   */
  resetIdentity(): void {
    const current = client;
    if (current === null) return;
    current.resetIdentity();
  },

  /** A snapshot of what the SDK is doing. Cheap; safe to poll from a debug panel. */
  get diagnostics(): Diagnostics {
    const snapshot = snapshots.current;
    return {
      isStarted: snapshot.isStarted,
      deviceIdentity: snapshot.deviceId,
      lastSuccessfulFetchEpochMillis: snapshot.lastSuccessfulFetchEpochMillis,
      freshFlagCount: snapshot.fresh?.size ?? 0,
      cachedFlagCount: snapshot.cached?.size ?? 0,
      sentTagKeys: snapshot.sentTagKeys,
    };
  },
};

function teardown(): void {
  client?.stop();
  client = null;
  if (identityUnlisten !== null) {
    identityUnlisten();
    identityUnlisten = null;
  }
  if (visibilityHandler !== null && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", visibilityHandler);
    visibilityHandler = null;
  }
}

/** Copies the handlers out before calling any of them: a handler that registers or removes
 * another handler would otherwise mutate the map mid-iteration. */
function broadcast(changed: ReadonlySet<string>): void {
  for (const handler of [...listeners.values()]) {
    try {
      handler(changed);
    } catch {
      // A listener throwing must not take down the notification fan-out — or the host page.
    }
  }
}
