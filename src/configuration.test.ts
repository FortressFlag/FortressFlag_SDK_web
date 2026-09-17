import { describe, expect, it } from "vitest";
import {
  Environment,
  SIGNATURE_DISABLED,
  TrustedKeys,
  resolveConfiguration,
  signatureRequired,
  validateConfiguration,
} from "./configuration.js";

function validate(overrides: Partial<Parameters<typeof resolveConfiguration>[0]> = {}) {
  return validateConfiguration(
    resolveConfiguration({
      sdkKey: "ffc_dev_k",
      environment: Environment.DEVELOPMENT,
      signaturePolicy: SIGNATURE_DISABLED,
      ...overrides,
    }),
  );
}

describe("Environment.of", () => {
  it("accepts well-formed keys and rejects the rest", () => {
    expect(Environment.of("eu-live")?.key).toBe("eu-live");
    expect(Environment.of("qa")?.key).toBe("qa");
    expect(Environment.of("")).toBeNull();
    expect(Environment.of("a")).toBeNull();
    expect(Environment.of("-dev")).toBeNull();
    expect(Environment.of("dev-")).toBeNull();
    expect(Environment.of("Dev")).toBeNull();
    expect(Environment.of("has_underscore")).toBeNull();
    expect(Environment.of("x".repeat(33))).toBeNull();
  });
});

describe("validateConfiguration", () => {
  it("accepts a well-formed configuration", () => {
    expect(validate()).toEqual([]);
  });

  it("reports an empty key", () => {
    expect(validate({ sdkKey: "" }).map((p) => p.code)).toEqual(["emptySdkKey"]);
  });

  it("accepts a key whose random part contains underscores", () => {
    // The SplitN trap in its JS disguise: split("_", 3) TRUNCATES the tail, so a naive port
    // mis-rejects roughly three keys in four. The random part is base64url and `_` is in
    // its alphabet — this key is VALID.
    expect(validate({ sdkKey: "ffc_dev_a_b_c" })).toEqual([]);
  });

  it("rejects malformed keys", () => {
    for (const key of ["ffc", "ffc_", "ffc_dev", "ffc_dev_", "ffm_dev_k", "_dev_k"]) {
      expect(
        validate({ sdkKey: key }).map((p) => p.code),
        key,
      ).toEqual(["sdkKeyWrongFormat"]);
    }
  });

  it("reports a key scoped to a different environment", () => {
    expect(validate({ sdkKey: "ffc_prod_k" }).map((p) => p.code)).toEqual([
      "sdkKeyEnvironmentMismatch",
    ]);
  });

  it("allows plaintext to loopback hosts only — no opt-in flag exists on web", () => {
    expect(validate({ baseUrl: "http://localhost:8080" })).toEqual([]);
    expect(validate({ baseUrl: "http://127.0.0.1:8080" })).toEqual([]);
    expect(validate({ baseUrl: "http://[::1]:8080" })).toEqual([]);
    expect(validate({ baseUrl: "http://example.com" }).map((p) => p.code)).toEqual([
      "insecureBaseUrl",
    ]);
    // 10.0.2.2 is the Android emulator's alias — it does not join the web set.
    expect(validate({ baseUrl: "http://10.0.2.2:8080" }).map((p) => p.code)).toEqual([
      "insecureBaseUrl",
    ]);
  });

  it("reports required signing with no trusted keys", () => {
    expect(
      validate({
        signaturePolicy: signatureRequired(new TrustedKeys({})),
      }).map((p) => p.code),
    ).toEqual(["signatureRequiredButNoTrustedKeys"]);
  });

  it("ships the production key: prod-2026-09-k1, a raw 32-byte Ed25519 public key", () => {
    // The default policy is required-with-production (ADR-0025); an empty constant would
    // make every real payload rejected. The value itself is pinned by the cross-check
    // against the backend's published key, not here.
    const key = TrustedKeys.FORTRESSFLAG_PRODUCTION.keysById.get("prod-2026-09-k1");
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key?.length).toBe(32);
    expect(validate({})).toEqual([]);
  });

  it("reports a refresh interval below the floor", () => {
    expect(validate({ refreshIntervalSeconds: 29 }).map((p) => p.code)).toEqual([
      "refreshIntervalTooShort",
    ]);
    expect(validate({ refreshIntervalSeconds: 30 })).toEqual([]);
  });
});
