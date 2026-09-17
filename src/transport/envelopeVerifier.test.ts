import { describe, expect, it } from "vitest";
import { Environment, SIGNATURE_DISABLED } from "../configuration.js";
import {
  FIXTURE_DEVICE,
  FIXTURE_NOW_MILLIS,
  envelopeBytes,
  payloadJson,
} from "../testsupport/envelopeFixture.js";
import { describeSignatureVerification } from "../testsupport/signatureSuite.js";
import type { Expectations } from "./envelopeVerifier.js";
import { verifyEnvelope } from "./envelopeVerifier.js";

const expectations: Expectations = {
  environment: Environment.DEVELOPMENT,
  deviceId: FIXTURE_DEVICE,
  nowMillis: FIXTURE_NOW_MILLIS,
};

async function rejectionOf(raw: Uint8Array, exp: Expectations = expectations): Promise<string> {
  const result = await verifyEnvelope(raw, SIGNATURE_DISABLED, exp);
  if (result.accepted) return "accepted";
  return result.rejection.code;
}

describe("verifyEnvelope — shape", () => {
  it("accepts a well-formed unsigned envelope under disabled", async () => {
    const result = await verifyEnvelope(envelopeBytes(), SIGNATURE_DISABLED, expectations);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.envelope.payload.flags.get("dark-mode")).toEqual({
        kind: "boolean",
        value: true,
      });
      expect(result.envelope.payload.device).toBe(FIXTURE_DEVICE);
    }
  });

  it("rejects non-envelopes wholesale", async () => {
    const encoder = new TextEncoder();
    for (const bytes of [
      new Uint8Array(0),
      encoder.encode("<html>captive portal</html>"),
      encoder.encode("{"),
      encoder.encode("null"),
      encoder.encode(`{"payload":""}`),
      encoder.encode(`{"payload":"!!!not-base64url!!!"}`),
    ]) {
      expect(await rejectionOf(bytes)).toBe("malformedEnvelope");
    }
  });

  it("rejects the WHOLE envelope on a value-union violation (scalars only, ADR-0008)", async () => {
    for (const flags of [`{"alpha":null}`, `{"alpha":{"nested":true}}`, `{"alpha":[1,2]}`]) {
      expect(await rejectionOf(envelopeBytes(payloadJson({ flagsJson: flags })))).toBe(
        "malformedPayload",
      );
    }
  });

  it("ignores unknown top-level payload fields — the server may add fields additively", async () => {
    const payload = payloadJson().replace(`"flags"`, `"futureField":"ignored","flags"`);
    expect(await rejectionOf(envelopeBytes(payload))).toBe("accepted");
  });

  it("accepts RFC3339 with and without fractional seconds, and offset forms", async () => {
    for (const issuedAt of [
      "2026-08-19T08:59:00Z",
      "2026-08-19T08:59:00.123Z",
      "2026-08-19T08:59:00+00:00",
    ]) {
      expect(await rejectionOf(envelopeBytes(payloadJson({ issuedAt }))), issuedAt).toBe(
        "accepted",
      );
    }
  });

  it("rejects date shapes Date.parse would happily accept", async () => {
    // Date.parse("2026-08-19") parses; the regex must not let it through.
    for (const issuedAt of ["2026-08-19", "2026-08-19T08:59Z", "Tue Aug 19 2026", "12345"]) {
      expect(await rejectionOf(envelopeBytes(payloadJson({ issuedAt }))), issuedAt).toBe(
        "malformedPayload",
      );
    }
  });
});

describe("verifyEnvelope — binding", () => {
  it("rejects a contract version outside the supported range", async () => {
    expect(await rejectionOf(envelopeBytes(payloadJson({ version: 99 })))).toBe(
      "unsupportedContractVersion",
    );
    expect(await rejectionOf(envelopeBytes(payloadJson({ version: 0 })))).toBe(
      "unsupportedContractVersion",
    );
  });

  it("accepts v1 — the durable cache may hold one across an SDK upgrade", async () => {
    expect(await rejectionOf(envelopeBytes(payloadJson({ version: 1 })))).toBe("accepted");
  });

  it("rejects another environment's payload", async () => {
    expect(await rejectionOf(envelopeBytes(payloadJson({ environment: "prod" })))).toBe(
      "environmentMismatch",
    );
  });

  it("rejects another device's payload", async () => {
    expect(
      await rejectionOf(envelopeBytes(payloadJson({ device: "dev_BBBBBBBBBBBBBBBBBBAAAA" }))),
    ).toBe("deviceMismatch");
  });

  it("skips the device check when the identity is unknown — the storage-unavailable path", async () => {
    const exp: Expectations = { ...expectations, deviceId: null };
    expect(
      await rejectionOf(envelopeBytes(payloadJson({ device: "dev_BBBBBBBBBBBBBBBBBBAAAA" })), exp),
    ).toBe("accepted");
  });

  it("rejects a payload issued beyond clock skew in the future, tolerates within skew", async () => {
    expect(
      await rejectionOf(envelopeBytes(payloadJson({ issuedAt: "2026-08-19T10:00:00Z" }))),
    ).toBe("issuedInTheFuture");
    // 4 minutes ahead: inside the 300s tolerance — end users set their clocks.
    expect(
      await rejectionOf(envelopeBytes(payloadJson({ issuedAt: "2026-08-19T09:04:00Z" }))),
    ).toBe("accepted");
  });

  it("enforces expiry on live responses and NOT on cache loads — the expiry asymmetry", async () => {
    const expired = envelopeBytes(
      payloadJson({ issuedAt: "2026-08-18T08:00:00Z", expiresAt: "2026-08-18T08:30:00Z" }),
    );
    expect(await rejectionOf(expired)).toBe("expired");
    // Cache load: expiry governs freshness, not validity (Founding §8.4) — a browser
    // offline for a month still serves what it last saw.
    expect(await rejectionOf(expired, { ...expectations, enforceExpiry: false })).toBe("accepted");
  });
});

// The signature matrix — the RFC 8032 vectors, fresh-key signing, unknown/wrong keys, the
// disabled opt-out and the unverifiable-platform outcome — is the shared suite, asserted
// here under Node's WebCrypto and in envelopeVerifier.browser.test.ts under chromium's.
describeSignatureVerification("node WebCrypto");
