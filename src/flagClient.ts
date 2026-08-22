import type { ResolvedConfiguration } from "./configuration.js";
import type { EnvelopeCache } from "./cache/envelopeCache.js";
import { changedKeys as computeChangedKeys } from "./evaluation/resolver.js";
import type { IdentitySource } from "./identity/deviceIdentityStore.js";
import type { RefreshFailure, RefreshOutcome } from "./resolution.js";
import type { SnapshotStore } from "./snapshot.js";
import type { Log } from "./support/log.js";
import { RESERVED_TAG_KEYS } from "./tags/builtinTags.js";
import { encodeTags, sanitizeTags } from "./tags/tags.js";
import { Backoff, SYSTEM_RANDOM, type RandomInRange } from "./transport/backoff.js";
import type { ClientApi } from "./transport/clientApi.js";
import type { TransportFailure } from "./transport/clientApi.js";
import { verifyEnvelope, type Expectations } from "./transport/envelopeVerifier.js";

export interface FlagClientDeps {
  readonly configuration: ResolvedConfiguration;
  readonly identity: IdentitySource;
  readonly api: ClientApi;
  readonly cache: EnvelopeCache;
  readonly store: SnapshotStore;
  readonly log: Log;
  readonly builtinTags: Readonly<Record<string, string>>;
  readonly backoff?: Backoff;
  readonly now?: () => number;
  readonly random?: RandomInRange;
  readonly notify: (changed: ReadonlySet<string>) => void;
}

/**
 * Orchestrates identity, transport and cache, and publishes results into the
 * [SnapshotStore]. The synchronous read path never touches this class — it reads the store
 * directly.
 */
export class FlagClient {
  private readonly configuration: ResolvedConfiguration;
  private readonly identity: IdentitySource;
  private readonly api: ClientApi;
  private readonly cache: EnvelopeCache;
  private readonly store: SnapshotStore;
  private readonly log: Log;
  private readonly builtinTags: Readonly<Record<string, string>>;
  private readonly backoff: Backoff;
  private readonly now: () => number;
  private readonly random: RandomInRange;
  private readonly notify: (changed: ReadonlySet<string>) => void;

  private etag: string | null = null;
  private inFlight: Promise<RefreshOutcome> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private consecutiveFailures = 0;
  private lastRetryAfterSeconds: number | null = null;
  private customTags: Record<string, string>;
  private encodedTags: string | null;

  constructor(deps: FlagClientDeps) {
    this.configuration = deps.configuration;
    this.identity = deps.identity;
    this.api = deps.api;
    this.cache = deps.cache;
    this.store = deps.store;
    this.log = deps.log;
    this.builtinTags = deps.builtinTags;
    this.backoff = deps.backoff ?? new Backoff();
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? SYSTEM_RANDOM;
    this.notify = deps.notify;
    this.customTags = sanitizeTags(this.configuration.tags, RESERVED_TAG_KEYS, this.log);
    this.encodedTags = encodeTags(this.builtinTags, this.customTags, this.log);
  }

  // --- lifecycle -----------------------------------------------------------------------

  /**
   * Begins polling. [restoredEtag] comes from the synchronous cache load the facade already
   * performed — see [loadCacheIntoStore]. The identity resolves here (it may mint), and the
   * first poll fires immediately.
   */
  start(restoredEtag: string | null): void {
    this.etag = restoredEtag;
    this.publishTagKeys();
    const deviceId = this.identity.identity();
    if (deviceId !== null) {
      this.store.update((s) => ({ ...s, deviceId }));
    }
    void this.pollOnce();
  }

  /** Stops polling. Values already resolved keep resolving from memory and cache. */
  stop(): void {
    this.stopped = true;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  resetIdentity(): void {
    this.identity.reset();
    this.cache.clear();
    this.etag = null;
    this.consecutiveFailures = 0;
    this.store.update((s) => ({ ...s, fresh: null, cached: null, deviceId: null }));
    this.log.debug("identity and cached values cleared");
  }

  // --- tags ----------------------------------------------------------------------------

  /**
   * Replaces the custom tag set. The caller follows with one coalesced [refresh], so a
   * login-driven tag takes effect within a request rather than a poll.
   */
  setTags(tags: Readonly<Record<string, string>>): void {
    this.customTags = sanitizeTags(tags, RESERVED_TAG_KEYS, this.log);
    const encoded = encodeTags(this.builtinTags, this.customTags, this.log);
    if (encoded !== this.encodedTags) {
      // A different tag set can mean a different payload for this same device, so the
      // stored validator no longer names what the next response would be — in memory AND
      // in the durable cache, or a page reload would resurrect the stale validator.
      this.etag = null;
      this.cache.clearEtag();
    }
    this.encodedTags = encoded;
    this.publishTagKeys();
    this.log.debug(`custom tags replaced (${Object.keys(this.customTags).length} tag(s) kept)`);
  }

  private publishTagKeys(): void {
    const keys = [...Object.keys(this.customTags), ...Object.keys(this.builtinTags)].sort();
    this.store.update((s) => ({ ...s, sentTagKeys: keys }));
  }

  // --- refresh -------------------------------------------------------------------------

  /**
   * Fetches new values, coalescing concurrent callers onto one request. Coalescing is not
   * an optimisation: without it, a page calling refresh() from several components on
   * visibility would issue several identical requests, and the SDK would be the reason the
   * customer hit their own rate limit.
   *
   * The returned promise NEVER rejects — a rejected promise is a throw to the caller, and
   * an unhandled rejection inside the poll loop surfaces in the customer's error tracking
   * as OUR crash (Founding §8.1).
   */
  refresh(): Promise<RefreshOutcome> {
    if (this.inFlight !== null) return this.inFlight;
    const flight = this.performRefresh()
      .catch((error: unknown) => {
        // Nothing may escape to a caller; an unexpected failure is a failed refresh, and
        // the cache keeps answering.
        const name = error instanceof Error ? error.name : "unknown";
        this.log.error(`refresh failed unexpectedly: ${name}`);
        return { type: "failed", failure: "network" } as const;
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = flight;
    return flight;
  }

  private async performRefresh(): Promise<RefreshOutcome> {
    const deviceId = this.identity.identity();
    if (deviceId === null) {
      this.log.debug("no device identity available");
      this.recordFailure(null);
      return { type: "failed", failure: "network" };
    }
    this.store.update((s) => ({ ...s, deviceId }));

    const outcome = await this.api.fetchFlags(deviceId, this.etag, this.encodedTags);
    switch (outcome.type) {
      case "notModified": {
        // A 304 is a successful conversation with the server, so it counts as a fetch:
        // leaving lastSuccessfulFetch stale would make a healthy browser whose flags simply
        // have not changed look, on a diagnostics panel, exactly like one that has been
        // failing for a week.
        this.recordSuccess();
        this.store.update((s) => ({ ...s, lastSuccessfulFetchEpochMillis: this.now() }));
        return { type: "unchanged" };
      }
      case "failure": {
        this.log.debug(`flag fetch failed: ${outcome.failure.code}`);
        const retryAfter =
          outcome.failure.code === "rateLimited" ? outcome.failure.retryAfterSeconds : null;
        this.recordFailure(retryAfter);
        return { type: "failed", failure: classify(outcome.failure) };
      }
      case "success":
        return this.accept(outcome.raw, outcome.etag, deviceId);
    }
  }

  /**
   * Verifies a freshly-fetched payload and, only if it passes, promotes it to both the live
   * snapshot and the durable cache.
   *
   * A rejected payload leaves the cache untouched. That ordering is the point: an attacker
   * who can serve responses cannot erase what the browser already knows — they can only
   * fail to change it.
   */
  private accept(raw: Uint8Array, responseEtag: string | null, deviceId: string): RefreshOutcome {
    const expectations: Expectations = {
      environment: this.configuration.environment,
      deviceId,
      nowMillis: this.now(),
    };
    const result = verifyEnvelope(raw, this.configuration.signaturePolicy, expectations);
    if (!result.accepted) {
      this.log.error(
        `rejected a flag payload: ${result.rejection.code}. Serving the last known values.`,
      );
      this.recordFailure(null);
      return { type: "failed", failure: "rejectedPayload" };
    }

    const payloadFlags = result.envelope.payload.flags;
    const previous = this.store.current;
    const changed = computeChangedKeys(previous.fresh, payloadFlags, previous.cached);

    this.cache.store(raw, responseEtag);
    this.etag = responseEtag;
    this.recordSuccess();
    // The cache tier mirrors the accepted payload so the two never disagree within a
    // session — and so a later rejection falls back to something we have verified.
    // Wholesale overwrite, both tiers: a key that left the payload stops resolving from
    // either on this same poll (ADR-0003).
    this.store.update((s) => ({
      ...s,
      fresh: payloadFlags,
      cached: payloadFlags,
      lastSuccessfulFetchEpochMillis: this.now(),
    }));

    if (changed.size === 0) return { type: "unchanged" };
    this.log.debug(`flag values changed (${changed.size} key(s))`);
    try {
      this.notify(changed);
    } catch {
      // A hostile or buggy change handler must not turn a successful refresh into a
      // failure — or reach the host page.
    }
    return { type: "updated", changedKeys: changed };
  }

  // --- cache ---------------------------------------------------------------------------

  /**
   * Reads the durable cache and publishes it, returning the stored ETag. Synchronous on
   * purpose: it runs during [FortressFlag.start], before that call returns, so that an
   * `isEnabled` on the very next line of the host page already sees the last values this
   * browser had (`localStorage` is synchronous, which makes this trivially natural here —
   * the test pins it anyway). Deferring it would mean every cold load briefly answers
   * `false` for every flag — a visible flicker of un-launched features, precisely what the
   * durable cache exists to prevent (Founding §8.4).
   */
  loadCacheIntoStore(): string | null {
    const cached = this.cache.load();
    if (cached === null) return null;

    // The identity may not be resolvable yet; the verifier skips the device check when
    // null rather than discarding the fallback — see Expectations.deviceId.
    let knownDevice: string | null;
    try {
      knownDevice = this.identity.peekStored();
    } catch {
      knownDevice = null;
    }

    const expectations: Expectations = {
      environment: this.configuration.environment,
      deviceId: knownDevice,
      nowMillis: this.now(),
      // Expiry is a freshness signal, not a validity one: an offline browser must keep
      // serving what it last saw for as long as it stays offline (Founding §8.4).
      enforceExpiry: false,
    };

    const result = verifyEnvelope(cached.raw, this.configuration.signaturePolicy, expectations);
    if (result.accepted) {
      const flags = result.envelope.payload.flags;
      this.store.update((s) => ({ ...s, cached: flags }));
      this.log.debug(`restored ${flags.size} cached flag value(s)`);
      return cached.etag;
    }
    // A cache we cannot verify is a cache we cannot use. Removing it stops us re-reading
    // and re-rejecting the same bytes on every load, and an unverifiable entry is exactly
    // what a poisoning attempt looks like.
    this.log.warning(`discarding an unverifiable flag cache: ${result.rejection.code}`);
    this.cache.clear();
    return null;
  }

  // --- polling -------------------------------------------------------------------------

  /**
   * How stale is too stale for the visibility hook: one refresh interval. Background tabs
   * throttle timers to ≥1/minute, so the poll cadence is best-effort in hidden tabs — the
   * `visibilitychange → visible` refresh (installed by the facade) is what keeps a
   * returning user fresh, the web analog of iOS's refresh-on-foreground guidance.
   */
  isStaleNow(): boolean {
    const last = this.store.current.lastSuccessfulFetchEpochMillis;
    if (last === null) return true;
    return this.now() - last > this.configuration.refreshIntervalSeconds * 1000;
  }

  private async pollOnce(): Promise<void> {
    await this.refresh();
    this.scheduleNextPoll();
  }

  private scheduleNextPoll(): void {
    if (this.stopped) return;
    const delaySeconds =
      this.consecutiveFailures > 0
        ? this.backoff.retryDelayWithServerHint(
            this.lastRetryAfterSeconds,
            this.consecutiveFailures,
            this.random,
          )
        : this.backoff.pollDelaySeconds(this.configuration.refreshIntervalSeconds, this.random);
    this.pollTimer = setTimeout(
      () => {
        void this.pollOnce();
      },
      Math.max(0, delaySeconds * 1000),
    );
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.lastRetryAfterSeconds = null;
  }

  private recordFailure(retryAfterSeconds: number | null): void {
    // Saturating rather than wrapping: a browser offline for a very long time keeps the
    // cap, it does not wrap around to retrying every two seconds.
    if (this.consecutiveFailures < Number.MAX_SAFE_INTEGER - 1) this.consecutiveFailures += 1;
    this.lastRetryAfterSeconds = retryAfterSeconds;
  }
}

function classify(failure: TransportFailure): RefreshFailure {
  switch (failure.code) {
    case "unauthorized":
      return "unauthorized";
    case "rateLimited":
      return "rateLimited";
    case "serverError":
    case "unexpectedStatus":
    case "responseTooLarge":
      return "server";
    default:
      return "network";
  }
}
