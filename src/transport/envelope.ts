import type { FlagValue } from "../flagValue.js";

/**
 * The contract version this SDK build ASKS FOR (`?v=2` on every fetch). Checked, not
 * assumed: an SDK that meets a `v` it does not know must fall back to the cache rather than
 * guess at a payload whose meaning has changed (Founding §5).
 */
export const SUPPORTED_CONTRACT_VERSION = 2;

/**
 * Every version this build can DECODE, as a range. v1 stays accepted for one load-bearing
 * reason: the durable cache holds whatever envelope the browser last accepted, and the first
 * load after an SDK upgrade reads a v1 entry. Rejecting it would boot every updating
 * customer's page into the `false` fallback for a session — the exact flicker the cache
 * exists to prevent (Founding §8.4).
 */
export const MIN_SUPPORTED_CONTRACT_VERSION = 1;

/**
 * The outer envelope: an opaque payload and a detached signature over its exact bytes.
 *
 * **Nothing lives outside the signature.** An inline JSON object with a `sig` field
 * alongside the data would require the server and every SDK to agree, byte for byte, on a
 * canonical serialisation; any divergence between Go and TypeScript would fail on some
 * payloads and not others, in browsers we cannot debug and cannot recall. Signing the
 * literal transmitted bytes removes that class of bug — and means no field can be trusted
 * before the signature check, because there is no field to read.
 */
export interface SignedEnvelope {
  /** Unpadded base64url of the payload JSON. */
  readonly payload: string;
  /**
   * `ed25519:<keyID>:<unpadded base64url signature>`. Absent only when the server is not
   * signing (true of every real response until backend M4), which a `required` policy
   * rejects.
   */
  readonly sig: string | null;
}

/**
 * The signed payload: this browser's flag values for one environment at one moment.
 *
 * Note what is *not* here. No flag names, no descriptions, no `updatedAt` — those are
 * management prose that must never reach an end-user's browser (Founding §2.1). The device
 * gets keys and scalar values.
 */
export interface FlagPayload {
  readonly version: number;
  readonly tenant: string;
  readonly environment: string;
  readonly device: string;
  readonly issuedAtMillis: number;
  readonly expiresAtMillis: number;
  readonly flags: ReadonlyMap<string, FlagValue>;
}

const decoder = new TextDecoder();

/** Decodes the outer envelope, or null when it is not the envelope shape. */
export function parseEnvelope(raw: Uint8Array): SignedEnvelope | null {
  let json: unknown;
  try {
    json = JSON.parse(decoder.decode(raw));
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof payload !== "string" || payload.length === 0) return null;
  const sig = record["sig"];
  return { payload, sig: typeof sig === "string" ? sig : null };
}

/**
 * Decodes the inner payload, or null on any malformation — including a flag value that is
 * null, an object or an array: the union is scalars only (ADR-0008), and a shape this build
 * does not understand rejects the WHOLE envelope. Unknown top-level fields are ignored so
 * the server can add fields additively.
 */
export function parsePayload(payloadBytes: Uint8Array): FlagPayload | null {
  let json: unknown;
  try {
    json = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;

  const version = record["v"];
  const tenant = record["tenant"];
  const environment = record["environment"];
  const device = record["device"];
  if (typeof version !== "number" || !Number.isInteger(version)) return null;
  if (typeof tenant !== "string" || typeof environment !== "string" || typeof device !== "string")
    return null;

  const issuedAtMillis = parseRfc3339(record["issuedAt"]);
  const expiresAtMillis = parseRfc3339(record["expiresAt"]);
  if (issuedAtMillis === null || expiresAtMillis === null) return null;

  const flagsJson = record["flags"];
  if (typeof flagsJson !== "object" || flagsJson === null || Array.isArray(flagsJson)) return null;
  const flags = new Map<string, FlagValue>();
  for (const [key, raw] of Object.entries(flagsJson as Record<string, unknown>)) {
    const value = decodeValue(raw);
    if (value === null) return null;
    flags.set(key, value);
  }

  return { version, tenant, environment, device, issuedAtMillis, expiresAtMillis, flags };
}

/** The value union: a bare JSON boolean, string or number. Anything else is null. */
function decodeValue(raw: unknown): FlagValue | null {
  switch (typeof raw) {
    case "boolean":
      return { kind: "boolean", value: raw };
    case "string":
      return { kind: "string", value: raw };
    case "number":
      // The contract says float64; JSON.parse already collapses every number spelling to it.
      return { kind: "number", value: raw };
    default:
      return null;
  }
}

/**
 * RFC 3339, accepted **with or without fractional seconds** (and with `+00:00`-style offsets
 * as well as `Z`).
 *
 * The backend emits `time.RFC3339` (no fraction) today. Accepting both is not laxity: a
 * server-side change from `RFC3339` to `RFC3339Nano` is invisible in a Go code review and
 * would otherwise brick every shipped SDK (Founding §5). The shape is validated with a regex
 * BEFORE `new Date` sees it — `Date.parse` alone is famously lenient (`"2026-08-19"` parses;
 * so do many non-RFC3339 strings), and that laxity would let a malformed server field pass
 * as a date. The tolerance is deliberate; the laxity is not.
 */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseRfc3339(raw: unknown): number | null {
  if (typeof raw !== "string" || !RFC3339.test(raw)) return null;
  const millis = Date.parse(raw);
  return Number.isNaN(millis) ? null : millis;
}
