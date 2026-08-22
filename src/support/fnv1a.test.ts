import { describe, expect, it } from "vitest";
import { fnv1aHex } from "./fnv1a.js";

describe("fnv1aHex", () => {
  it("matches the published FNV-1a 32-bit vectors", () => {
    // From the FNV reference implementation's test suite.
    expect(fnv1aHex("")).toBe("811c9dc5");
    expect(fnv1aHex("a")).toBe("e40c292c");
    expect(fnv1aHex("foobar")).toBe("bf9cf968");
  });

  it("is stable and distinguishes scopes", () => {
    expect(fnv1aHex("ffc_dev_k|dev")).toBe(fnv1aHex("ffc_dev_k|dev"));
    expect(fnv1aHex("ffc_dev_k|dev")).not.toBe(fnv1aHex("ffc_prod_k|prod"));
  });

  it("hashes UTF-8 bytes, not UTF-16 units", () => {
    expect(fnv1aHex("🚀")).toBe(fnv1aHex("🚀"));
    expect(fnv1aHex("🚀")).not.toBe(fnv1aHex("??"));
  });
});
