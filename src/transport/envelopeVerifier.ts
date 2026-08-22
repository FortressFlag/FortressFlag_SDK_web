import type { Environment, SignaturePolicy, TrustedKeys } from "../configuration.js";
import { decodeBase64Url } from "../support/base64url.js";
import type { FlagPayload } from "./envelope.js";
import {
  MIN_SUPPORTED_CONTRACT_VERSION,
  SUPPORTED_CONTRACT_VERSION,
  parseEnvelope,
  parsePayload,
} from "./envelope.js";

/**
 * Why an envelope was not accepted. A rejection is never fatal: it means "serve the last
 * value this browser saw" (Founding §8.4). Enumerated in this much detail because "flags
 * stopped updating" is otherwise one of the hardest things to debug in a customer's page,
 * and the answer should be one console line.
 */
export interface EnvelopeRejection {
  readonly code:
    | "malformedEnvelope"
    | "missingSignature"
    | "malformedSignature"
    | "unsupportedSignatureAlgorithm"
    | "unknownKeyId"
    | "badSignature"
    | "malformedPayload"
    | "unsupportedContractVersion"
    | "environmentMismatch"
    | "deviceMismatch"
    | "expired"
    | "issuedInTheFuture";
  readonly detail?: string;
}

/**
 * An envelope that passed every check, kept alongside the exact bytes it arrived as. `raw`
 * is retained so the cache stores what was signed rather than a re-serialisation of what we
 * parsed — re-serialising would silently strip any field a future server adds and break the
 * signature on reload.
 */
export interface VerifiedEnvelope {
  readonly raw: Uint8Array;
  readonly payload: FlagPayload;
}

/** What the payload must claim to be, for it to be about us. */
export interface Expectations {
  readonly environment: Environment;
  /**
   * The device the payload must be addressed to, or null to skip that check. Null happens
   * in one situation: loading the cache when identity storage is unavailable, so the SDK
   * does not yet know its own identity. Skipping there is deliberate — the alternative is
   * discarding the last recorded value because of a *transient* storage failure, and the
   * entry being read is inside this origin's own storage.
   */
  readonly deviceId: string | null;
  readonly nowMillis: number;
  /** Tolerance for a wrong device clock, in seconds. End users set their clocks; a machine
   * an hour fast should not lose flag updates. Default 300. */
  readonly clockSkewSeconds?: number;
  /**
   * Whether `expiresAt` is enforced. **True for a live response, false when loading the
   * cache** — and that asymmetry is the single most load-bearing rule in this SDK.
   *
   * On a live response, expiry is the replay window: without it, anyone who captured a
   * valid response could serve it back forever, pinning a browser to old flag values.
   *
   * On a cache load it must NOT apply. Founding §8.4 makes the last recorded value the
   * primary fallback: a browser offline for a month still serves what it last saw. Expiring
   * the cache would silently revert every flag to `false` — turning an outage into a
   * feature regression, which is precisely the failure the cascade exists to prevent.
   * **Expiry governs freshness, not validity.** Default true.
   */
  readonly enforceExpiry?: boolean;
}

export type VerifyResult =
  | { readonly accepted: true; readonly envelope: VerifiedEnvelope }
  | { readonly accepted: false; readonly rejection: EnvelopeRejection };

const DEFAULT_CLOCK_SKEW_SECONDS = 300;

export function verifyEnvelope(
  raw: Uint8Array,
  policy: SignaturePolicy,
  expectations: Expectations,
): VerifyResult {
  const envelope = parseEnvelope(raw);
  if (envelope === null) {
    return { accepted: false, rejection: { code: "malformedEnvelope" } };
  }
  const payloadBytes = decodeBase64Url(envelope.payload);
  if (payloadBytes === null) {
    return { accepted: false, rejection: { code: "malformedEnvelope" } };
  }

  if (policy.type === "required") {
    const rejection = checkSignature(envelope.sig, policy.trustedKeys);
    if (rejection !== null) return { accepted: false, rejection };
  }

  const payload = parsePayload(payloadBytes);
  if (payload === null) {
    return { accepted: false, rejection: { code: "malformedPayload" } };
  }

  const rejection = checkBinding(payload, expectations);
  if (rejection !== null) return { accepted: false, rejection };

  return { accepted: true, envelope: { raw, payload } };
}

/**
 * The signature *plumbing*, with the crypto primitive deliberately absent (backend
 * ADR-0013/0014): the backend's signing milestone (M4) has not shipped and its algorithm ADR
 * (P-256 vs Ed25519ph) is open. So: a missing signature under `required` is rejected (fail
 * closed — the iOS behaviour, byte for byte), the `algorithm:keyID:signature` splitting and
 * trust-store lookup are real, and a signature that *survives* those checks is still
 * rejected as `badSignature` because no primitive exists to accept it. When M4 lands, its
 * ADR decides the primitive and this is where it goes — with a real trust store, this stub
 * can reject valid payloads but can never accept a forged one.
 */
function checkSignature(sig: string | null, trustedKeys: TrustedKeys): EnvelopeRejection | null {
  if (sig === null) return { code: "missingSignature" };

  // Split at the first two colons so a key ID may contain a colon later without a breaking
  // parse change — found by index, never split(sep, limit), which truncates in JS.
  const first = sig.indexOf(":");
  const second = first < 0 ? -1 : sig.indexOf(":", first + 1);
  if (first < 0 || second < 0) return { code: "malformedSignature" };

  const algorithm = sig.substring(0, first);
  const keyId = sig.substring(first + 1, second);
  const signature = sig.substring(second + 1);
  if (algorithm !== "ed25519") {
    return { code: "unsupportedSignatureAlgorithm", detail: algorithm };
  }
  if (signature.length === 0 || decodeBase64Url(signature) === null) {
    return { code: "malformedSignature" };
  }
  if (!trustedKeys.keysById.has(keyId)) {
    return { code: "unknownKeyId", detail: keyId };
  }

  // The primitive gap, made explicit: the payload bytes are deliberately unused beyond this
  // point until M4 supplies the algorithm.
  return { code: "badSignature" };
}

/**
 * Confirms the payload is about *this* device, *this* environment, and *now* — in the
 * contract's order. A signature alone proves only that FortressFlag produced the bytes at
 * some point; without these checks a production payload could be replayed at a dev build,
 * another device's payload served to this one, and yesterday's values pinned in place
 * indefinitely.
 */
function checkBinding(payload: FlagPayload, expectations: Expectations): EnvelopeRejection | null {
  // The RANGE, not merely the newest: the durable cache may hold a v1 envelope across an
  // SDK upgrade — see MIN_SUPPORTED_CONTRACT_VERSION.
  if (
    payload.version < MIN_SUPPORTED_CONTRACT_VERSION ||
    payload.version > SUPPORTED_CONTRACT_VERSION
  ) {
    return { code: "unsupportedContractVersion", detail: String(payload.version) };
  }
  if (payload.environment !== expectations.environment.key) {
    return {
      code: "environmentMismatch",
      detail: `expected ${expectations.environment.key}, received ${payload.environment}`,
    };
  }
  if (expectations.deviceId !== null && payload.device !== expectations.deviceId) {
    return { code: "deviceMismatch" };
  }
  const skewMillis = (expectations.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS) * 1000;
  if (payload.issuedAtMillis - expectations.nowMillis > skewMillis) {
    return { code: "issuedInTheFuture" };
  }
  const enforceExpiry = expectations.enforceExpiry ?? true;
  if (enforceExpiry && expectations.nowMillis - payload.expiresAtMillis > skewMillis) {
    return { code: "expired" };
  }
  return null;
}
