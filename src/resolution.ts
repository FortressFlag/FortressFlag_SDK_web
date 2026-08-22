import type { FlagValue } from "./flagValue.js";

/**
 * Where a resolved value came from. Reported so a developer can tell "on because the server
 * said so" from "on because that is what this browser last heard" — a distinction that
 * matters a great deal when debugging a rollout.
 */
export type ValueSource =
  /** From the most recent successful fetch. */
  | "fresh"
  /** From the durable cache: the last value this browser actually saw. */
  | "cached"
  /** The default the caller passed. */
  | "developerDefault"
  /** `false`. Nothing has ever been recorded for this flag in this browser. */
  | "safeDefault";

/** A resolved flag value and its provenance. */
export interface Resolution {
  readonly value: FlagValue;
  readonly source: ValueSource;
}

/**
 * Why a refresh did not produce new values. Deliberately coarse and stable: this is a public
 * type, so it names *classes* of failure a caller might act on, not every internal rejection
 * reason. The detail goes to the console.
 */
export type RefreshFailure =
  | "network"
  | "unauthorized"
  | "rateLimited"
  | "server"
  /** A payload arrived but failed verification — bad signature, wrong environment, wrong
   * device, expired, or a contract version this SDK does not understand. */
  | "rejectedPayload";

/**
 * What happened on a refresh. Returned, never thrown — and the promise carrying it never
 * rejects: a rejected promise IS a throw to the caller (Founding §8.1).
 */
export type RefreshOutcome =
  /** New values arrived. `changedKeys` lists the flags whose *effective* value moved, which
   * is not the same as the flags present in the payload. */
  | { readonly type: "updated"; readonly changedKeys: ReadonlySet<string> }
  /** The server confirmed nothing changed, or the payload matched what we already had. */
  | { readonly type: "unchanged" }
  | { readonly type: "failed"; readonly failure: RefreshFailure }
  /** `start` has not been called. */
  | { readonly type: "notStarted" };

/** A read-only view of what the SDK is doing, for a customer's own diagnostics panel. */
export interface Diagnostics {
  readonly isStarted: boolean;
  /** The pseudonymous device identifier, if one has been minted. Safe to display and to
   * include in a support ticket — it is random and identifies nobody. */
  readonly deviceIdentity: string | null;
  /** Epoch millis of the last successful conversation with the server (a 304 counts). */
  readonly lastSuccessfulFetchEpochMillis: number | null;
  /** Number of flags in the most recent accepted payload. */
  readonly freshFlagCount: number;
  /** Number of flags in the durable cache. */
  readonly cachedFlagCount: number;
  /** The KEYS of the tags each fetch sends, sorted. Keys only, never values: the keys are
   * the integrator's own configuration; the values are not exposed anywhere. */
  readonly sentTagKeys: readonly string[];
}
