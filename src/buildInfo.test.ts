import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "./buildInfo.js";

describe("SDK_VERSION", () => {
  it("is a semantic version, because it lands verbatim in the X-FF-SDK header", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
