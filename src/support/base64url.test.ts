import { describe, expect, it } from "vitest";
import { decodeBase64Url, encodeBase64Url } from "./base64url.js";

describe("base64url", () => {
  it("round-trips bytes unpadded", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = encodeBase64Url(bytes);
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(decodeBase64Url(encoded)).toEqual(bytes);
  });

  it("encodes multibyte text safely through TextEncoder", () => {
    // The btoa trap: `btoa("🚀")` throws. Bytes-first is the whole design — this pins that
    // the supported path survives any tag value a customer can type.
    const bytes = new TextEncoder().encode("cohort-🚀-β");
    const encoded = encodeBase64Url(bytes);
    expect(new TextDecoder().decode(decodeBase64Url(encoded) ?? new Uint8Array())).toBe(
      "cohort-🚀-β",
    );
  });

  it("rejects text outside the base64url alphabet", () => {
    expect(decodeBase64Url("a+b")).toBeNull();
    expect(decodeBase64Url("a/b")).toBeNull();
    expect(decodeBase64Url("a=b")).toBeNull();
    expect(decodeBase64Url("a b")).toBeNull();
    expect(decodeBase64Url("!!!!")).toBeNull();
  });

  it("rejects an impossible length", () => {
    // length % 4 === 1 cannot be produced by any byte sequence.
    expect(decodeBase64Url("AAAAA")).toBeNull();
  });
});
