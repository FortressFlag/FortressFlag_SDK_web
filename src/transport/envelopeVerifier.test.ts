import { describe, expect, it } from "vitest";
import {
  Environment,
  SIGNATURE_DISABLED,
  TrustedKeys,
  signatureRequired,
} from "../configuration.js";
import {
  FIXTURE_DEVICE,
  FIXTURE_NOW_MILLIS,
  envelopeBytes,
  payloadJson,
} from "../testsupport/envelopeFixture.js";
import type { Expectations } from "./envelopeVerifier.js";
import { verifyEnvelope } from "./envelopeVerifier.js";

const expectations: Expectations = {
  environment: Environment.DEVELOPMENT,
  deviceId: FIXTURE_DEVICE,
  nowMillis: FIXTURE_NOW_MILLIS,
};

function rejectionOf(raw: Uint8Array, exp: Expectations = expectations): string {
  const result = verifyEnvelope(raw, SIGNATURE_DISABLED, exp);
  if (result.accepted) return "accepted";
  return result.rejection.code;
}

describe("verifyEnvelope — shape", () => {
  it("accepts a well-formed unsigned envelope under disabled", () => {
    const result = verifyEnvelope(envelopeBytes(), SIGNATURE_DISABLED, expectations);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.envelope.payload.flags.get("dark-mode")).toEqual({
        kind: "boolean",
        value: true,
      });
      expect(result.envelope.payload.device).toBe(FIXTURE_DEVICE);
    }
  });

  it("rejects non-envelopes wholesale", () => {
    const encoder = new TextEncoder();
    for (const bytes of [
      new Uint8Array(0),
      encoder.encode("<html>captive portal</html>"),
      encoder.encode("{"),
      encoder.encode("null"),
      encoder.encode(`{"payload":""}`),
      encoder.encode(`{"payload":"!!!not-base64url!!!"}`),
    ]) {
      expect(rejectionOf(bytes)).toBe("malformedEnvelope");
    }
  });

  it("rejects the WHOLE envelope on a value-union violation (scalars only, ADR-0008)", () => {
    for (const flags of [`{"alpha":null}`, `{"alpha":{"nested":true}}`, `{"alpha":[1,2]}`]) {
      expect(rejectionOf(envelopeBytes(payloadJson({ flagsJson: flags })))).toBe(
        "malformedPayload",
      );
    }
  });

  it("ignores unknown top-level payload fields — the server may add fields additively", () => {
    const payload = payloadJson().replace(`"flags"`, `"futureField":"ignored","flags"`);
    expect(rejectionOf(envelopeBytes(payload))).toBe("accepted");
  });

  it("accepts RFC3339 with and without fractional seconds, and offset forms", () => {
    for (const issuedAt of [
      "2026-08-19T08:59:00Z",
      "2026-08-19T08:59:00.123Z",
      "2026-08-19T08:59:00+00:00",
    ]) {
      expect(rejectionOf(envelopeBytes(payloadJson({ issuedAt }))), issuedAt).toBe("accepted");
    }
  });

  it("rejects date shapes Date.parse would happily accept", () => {
    // Date.parse("2026-08-19") parses; the regex must not let it through.
    for (const issuedAt of ["2026-08-19", "2026-08-19T08:59Z", "Tue Aug 19 2026", "12345"]) {
      expect(rejectionOf(envelopeBytes(payloadJson({ issuedAt }))), issuedAt).toBe(
        "malformedPayload",
      );
    }
  });
});

describe("verifyEnvelope — binding", () => {
  it("rejects a contract version outside the supported range", () => {
    expect(rejectionOf(envelopeBytes(payloadJson({ version: 99 })))).toBe(
      "unsupportedContractVersion",
    );
    expect(rejectionOf(envelopeBytes(payloadJson({ version: 0 })))).toBe(
      "unsupportedContractVersion",
    );
  });

  it("accepts v1 — the durable cache may hold one across an SDK upgrade", () => {
    expect(rejectionOf(envelopeBytes(payloadJson({ version: 1 })))).toBe("accepted");
  });

  it("rejects another environment's payload", () => {
    expect(rejectionOf(envelopeBytes(payloadJson({ environment: "prod" })))).toBe(
      "environmentMismatch",
    );
  });

  it("rejects another device's payload", () => {
    expect(rejectionOf(envelopeBytes(payloadJson({ device: "dev_BBBBBBBBBBBBBBBBBBAAAA" })))).toBe(
      "deviceMismatch",
    );
  });

  it("skips the device check when the identity is unknown — the storage-unavailable path", () => {
    const exp: Expectations = { ...expectations, deviceId: null };
    expect(
      rejectionOf(envelopeBytes(payloadJson({ device: "dev_BBBBBBBBBBBBBBBBBBAAAA" })), exp),
    ).toBe("accepted");
  });

  it("rejects a payload issued beyond clock skew in the future, tolerates within skew", () => {
    expect(rejectionOf(envelopeBytes(payloadJson({ issuedAt: "2026-08-19T10:00:00Z" })))).toBe(
      "issuedInTheFuture",
    );
    // 4 minutes ahead: inside the 300s tolerance — end users set their clocks.
    expect(rejectionOf(envelopeBytes(payloadJson({ issuedAt: "2026-08-19T09:04:00Z" })))).toBe(
      "accepted",
    );
  });

  it("enforces expiry on live responses and NOT on cache loads — the expiry asymmetry", () => {
    const expired = envelopeBytes(
      payloadJson({ issuedAt: "2026-08-18T08:00:00Z", expiresAt: "2026-08-18T08:30:00Z" }),
    );
    expect(rejectionOf(expired)).toBe("expired");
    // Cache load: expiry governs freshness, not validity (Founding §8.4) — a browser
    // offline for a month still serves what it last saw.
    expect(rejectionOf(expired, { ...expectations, enforceExpiry: false })).toBe("accepted");
  });
});

describe("verifyEnvelope — the signature matrix (fail-closed stub)", () => {
  const required = signatureRequired(new TrustedKeys({ k1: new Uint8Array(32) }));

  function requiredRejection(sig: string | null | undefined): string {
    const result = verifyEnvelope(envelopeBytes(payloadJson(), sig), required, expectations);
    return result.accepted ? "accepted" : result.rejection.code;
  }

  it("rejects every signature shape under required — the stub can never accept a forgery", () => {
    expect(requiredRejection(undefined)).toBe("missingSignature");
    expect(requiredRejection("garbage")).toBe("malformedSignature");
    expect(requiredRejection("ed25519:k1:!!!not-base64url!!!")).toBe("malformedSignature");
    expect(requiredRejection("p256:k1:AAAA")).toBe("unsupportedSignatureAlgorithm");
    expect(requiredRejection("ed25519:unknown-key:AAAA")).toBe("unknownKeyId");
    // Plausible in every checkable way — still rejected until backend M4 supplies the
    // primitive (safe half of the matrix: reject valid, never accept forged).
    expect(requiredRejection("ed25519:k1:AAAA")).toBe("badSignature");
  });

  it("accepts unsigned under disabled — the named local-dev opt-out", () => {
    const result = verifyEnvelope(envelopeBytes(), SIGNATURE_DISABLED, expectations);
    expect(result.accepted).toBe(true);
  });
});
