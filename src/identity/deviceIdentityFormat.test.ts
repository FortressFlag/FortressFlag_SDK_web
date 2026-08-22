import { describe, expect, it } from "vitest";
import { isWellFormedDeviceId, mintDeviceId } from "./deviceIdentity.js";
import vectors from "./device-ids.json";

// THE VECTOR FILE IS A CROSS-PLATFORM CONTRACT, not an implementation detail: iOS and
// Android assert the same table, the backend's ValidDeviceID enforces the same shape, and
// the canonical copy lives in FortressFlag_Standards/vectors/device-ids.json — the resource
// here is a byte-for-byte copy of it. "One device" has to mean the same thing on every
// platform (Founding §6.1); changing an expectation here is changing the wire contract, and
// it is never a test fix.
describe("device identity format", () => {
  it("accepts every accept vector", () => {
    for (const value of vectors.accept) {
      expect(isWellFormedDeviceId(value), `expected accept: ${value}`).toBe(true);
    }
  });

  it("rejects every reject vector", () => {
    for (const value of vectors.reject) {
      expect(isWellFormedDeviceId(value), `expected reject: ${value}`).toBe(false);
    }
  });

  it("rejects a non-canonical final character", () => {
    // A 22-char base64url body only strict-decodes when the final character's two low bits
    // are zero; the server decodes with Go's Strict() and answers 400 otherwise. Not in the
    // shared vector file (iOS's Foundation decoder enforces it implicitly), pinned here
    // because `atob` is lenient and the guard is our own re-encode-and-compare.
    expect(isWellFormedDeviceId("dev_AAAAAAAAAAAAAAAAAAAAAB")).toBe(false);
    expect(isWellFormedDeviceId("dev_AAAAAAAAAAAAAAAAAAAAAQ")).toBe(true);
  });

  it("mints well-formed, canonical identities", () => {
    for (let i = 0; i < 64; i++) {
      const id = mintDeviceId(false);
      expect(id.startsWith("dev_"), id).toBe(true);
      expect(isWellFormedDeviceId(id), id).toBe(true);
    }
    const sim = mintDeviceId(true);
    expect(sim.startsWith("sim_"), sim).toBe(true);
    expect(isWellFormedDeviceId(sim), sim).toBe(true);
  });

  it("mints unique identities", () => {
    const minted = Array.from({ length: 128 }, () => mintDeviceId(false));
    expect(new Set(minted).size).toBe(minted.length);
  });
});
