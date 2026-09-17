import { describe, expect, it } from "vitest";
import {
  Environment,
  SIGNATURE_DISABLED,
  TrustedKeys,
  signatureRequired,
} from "../configuration.js";
import { decodeBase64Url, encodeBase64Url } from "../support/base64url.js";
import type { Expectations } from "../transport/envelopeVerifier.js";
import { verifyEnvelope } from "../transport/envelopeVerifier.js";
import vectors from "../transport/signing.json";
import {
  FIXTURE_DEVICE,
  FIXTURE_NOW_MILLIS,
  envelopeBytes,
  payloadJson,
} from "./envelopeFixture.js";

// THE VECTOR FILE IS A CROSS-SDK CONTRACT (backend ADR-0025): every SDK feeds each `envelope`
// — the exact wire bytes, base64url — to its verifier unchanged and must reach the same
// verdict. The canonical copy is FortressFlag_Standards/vectors/signing.json; the resource
// beside the verifier is a byte-for-byte copy. Signed with the RFC 8032 §7.1 TEST 1 key,
// whose seed is published in the RFC and deliberately absent here.
//
// Shared by the unit lane (Node's WebCrypto) and the real-browser lane (chromium's): a test
// that passes in an environment WITHOUT Ed25519 is testing the fallback, not the crypto, so
// both lanes assert it — see the "verifiable" guard.

const encoder = new TextEncoder();

/** A throwaway Ed25519 pair, minted in memory per test run. Never persisted. */
export interface TestSigner {
  readonly keyId: string;
  readonly publicKey: Uint8Array;
  sign(bytes: Uint8Array): Promise<string>;
}

export async function newTestSigner(keyId = "test-2026-09-k1"): Promise<TestSigner> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    keyId,
    publicKey,
    async sign(bytes) {
      const sig = new Uint8Array(
        await crypto.subtle.sign("Ed25519", pair.privateKey, new Uint8Array(bytes)),
      );
      return `ed25519:${keyId}:${encodeBase64Url(sig)}`;
    },
  };
}

function decodeVector(envelope: string): Uint8Array {
  const bytes = decodeBase64Url(envelope);
  if (bytes === null) throw new Error("vector envelope is not base64url");
  return bytes;
}

/** The expectations the vector payloads were written for (environment prod, expiry 2099). */
export const vectorExpectations: Expectations = {
  environment: Environment.PRODUCTION,
  deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA",
  nowMillis: Date.parse("2026-09-16T01:00:00Z"),
};

export const vectorPolicy = signatureRequired(
  new TrustedKeys({ [vectors.keyId]: decodeVector(vectors.publicKey) }),
);

async function codeOf(
  raw: Uint8Array,
  policy = vectorPolicy,
  expectations = vectorExpectations,
): Promise<string> {
  const result = await verifyEnvelope(raw, policy, expectations);
  return result.accepted ? "accepted" : result.rejection.code;
}

export function describeSignatureVerification(lane: string): void {
  describe(`signature verification (${lane})`, () => {
    it("this lane can verify — otherwise every test below proves the fallback, not the crypto", async () => {
      expect(await codeOf(decodeVector(vectors.accept[0]?.envelope ?? ""))).not.toBe(
        "signatureUnverifiable",
      );
    });

    it("the vector's public key is 32 raw bytes", () => {
      expect(decodeVector(vectors.publicKey).length).toBe(32);
    });

    for (const entry of vectors.accept) {
      if (entry.name.startsWith("server-")) {
        it(`vector ${entry.name}: the signature verifies, the payload is the server plane's`, async () => {
          // A client SDK cannot decode a ruleset — but it checks the signature BEFORE it
          // parses (contract order), so the only rejection reachable here is the parse:
          // any signature code would mean the crypto disagreed with the backend.
          expect(await codeOf(decodeVector(entry.envelope))).toBe("malformedPayload");
        });
        continue;
      }
      it(`accepts vector ${entry.name}`, async () => {
        const result = await verifyEnvelope(
          decodeVector(entry.envelope),
          vectorPolicy,
          vectorExpectations,
        );
        expect(result.accepted, JSON.stringify(result)).toBe(true);
        if (result.accepted) {
          // The verified bytes are the wire bytes — no re-serialisation.
          expect([...result.envelope.raw]).toEqual([...decodeVector(entry.envelope)]);
        }
      });
    }

    for (const entry of vectors.reject) {
      it(`rejects vector ${entry.name} as ${entry.code}`, async () => {
        expect(await codeOf(decodeVector(entry.envelope))).toBe(entry.code);
      });
    }

    it("verifies a freshly signed payload, and rejects it once one flag is flipped", async () => {
      const signer = await newTestSigner();
      const policy = signatureRequired(new TrustedKeys({ [signer.keyId]: signer.publicKey }));
      const expectations: Expectations = {
        environment: Environment.DEVELOPMENT,
        deviceId: FIXTURE_DEVICE,
        nowMillis: FIXTURE_NOW_MILLIS,
      };
      const honest = payloadJson({ flagsJson: `{"dark-mode":true,"beta":false}` });
      const sig = await signer.sign(encoder.encode(honest));
      expect(await codeOf(envelopeBytes(honest, sig), policy, expectations)).toBe("accepted");

      const forged = payloadJson({ flagsJson: `{"dark-mode":false,"beta":false}` });
      expect(await codeOf(envelopeBytes(forged, sig), policy, expectations)).toBe("badSignature");
    });

    it("rejects an unknown key ID, and the RIGHT key ID under a different key", async () => {
      const signer = await newTestSigner();
      const other = await newTestSigner();
      const expectations: Expectations = {
        environment: Environment.DEVELOPMENT,
        deviceId: FIXTURE_DEVICE,
        nowMillis: FIXTURE_NOW_MILLIS,
      };
      const payload = payloadJson();
      const sig = await signer.sign(encoder.encode(payload));
      const raw = envelopeBytes(payload, sig);

      const unknown = signatureRequired(new TrustedKeys({ "some-other-key": signer.publicKey }));
      expect(await codeOf(raw, unknown, expectations)).toBe("unknownKeyId");

      const wrongKey = signatureRequired(new TrustedKeys({ [signer.keyId]: other.publicKey }));
      expect(await codeOf(raw, wrongKey, expectations)).toBe("badSignature");

      // A malformed key in our own trust store: "cannot verify with this key", not a crash.
      const shortKey = signatureRequired(new TrustedKeys({ [signer.keyId]: new Uint8Array(31) }));
      expect(await codeOf(raw, shortKey, expectations)).toBe("unknownKeyId");
    });

    it("accepts an unsigned envelope under disabled, rejects it under required", async () => {
      const expectations: Expectations = {
        environment: Environment.DEVELOPMENT,
        deviceId: FIXTURE_DEVICE,
        nowMillis: FIXTURE_NOW_MILLIS,
      };
      expect(await codeOf(envelopeBytes(), SIGNATURE_DISABLED, expectations)).toBe("accepted");
      expect(await codeOf(envelopeBytes(), vectorPolicy, expectations)).toBe("missingSignature");
    });

    it("reports signatureUnverifiable — never badSignature — when crypto.subtle is unusable", async () => {
      const signer = await newTestSigner();
      const policy = signatureRequired(new TrustedKeys({ [signer.keyId]: signer.publicKey }));
      const expectations: Expectations = {
        environment: Environment.DEVELOPMENT,
        deviceId: FIXTURE_DEVICE,
        nowMillis: FIXTURE_NOW_MILLIS,
      };
      const payload = payloadJson();
      const raw = envelopeBytes(payload, await signer.sign(encoder.encode(payload)));

      const realSubtle = crypto.subtle;
      const stubbed = {
        importKey: () => Promise.reject(new DOMException("Ed25519", "NotSupportedError")),
      } as unknown as SubtleCrypto;
      try {
        // Chrome < 137 / Safari < 17: importKey throws.
        Object.defineProperty(crypto, "subtle", { value: stubbed, configurable: true });
        expect(await codeOf(raw, policy, expectations)).toBe("signatureUnverifiable");
        // Insecure non-localhost origin: crypto.subtle is undefined.
        Object.defineProperty(crypto, "subtle", { value: undefined, configurable: true });
        expect(await codeOf(raw, policy, expectations)).toBe("signatureUnverifiable");
        // The other checks still fail closed ahead of the crypto.
        expect(await codeOf(envelopeBytes(payload), policy, expectations)).toBe("missingSignature");
      } finally {
        Object.defineProperty(crypto, "subtle", { value: realSubtle, configurable: true });
      }
      expect(await codeOf(raw, policy, expectations)).toBe("accepted");
    });
  });
}
