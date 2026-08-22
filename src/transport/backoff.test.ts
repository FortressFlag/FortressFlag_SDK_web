import { describe, expect, it } from "vitest";
import { Backoff } from "./backoff.js";

const low: (a: number, b: number) => number = (a) => a;
const high: (a: number, b: number) => number = (_a, b) => b;
const mid: (a: number, b: number) => number = () => 0;

describe("Backoff", () => {
  it("doubles from the base and caps", () => {
    const backoff = new Backoff();
    expect(backoff.retryDelaySeconds(1, mid)).toBe(2);
    expect(backoff.retryDelaySeconds(2, mid)).toBe(4);
    expect(backoff.retryDelaySeconds(3, mid)).toBe(8);
    expect(backoff.retryDelaySeconds(20, mid)).toBe(1800);
    // The exponent is capped: astronomical failure counts must not overflow to Infinity.
    expect(backoff.retryDelaySeconds(100_000, mid)).toBe(1800);
  });

  it("returns zero before any failure", () => {
    expect(new Backoff().retryDelaySeconds(0, mid)).toBe(0);
  });

  it("jitters ±20% on both the retry and the poll path", () => {
    const backoff = new Backoff();
    expect(backoff.retryDelaySeconds(2, low)).toBeCloseTo(4 * 0.8);
    expect(backoff.retryDelaySeconds(2, high)).toBeCloseTo(4 * 1.2);
    expect(backoff.pollDelaySeconds(300, low)).toBeCloseTo(240);
    expect(backoff.pollDelaySeconds(300, high)).toBeCloseTo(360);
  });

  it("obeys Retry-After but never past the cap", () => {
    const backoff = new Backoff();
    expect(backoff.retryDelayWithServerHint(7, 5, mid)).toBe(7);
    // A hostile or misconfigured Retry-After of a year must not silently disable flag
    // updates until the tab closes.
    expect(backoff.retryDelayWithServerHint(31_536_000, 1, mid)).toBe(1800);
    expect(backoff.retryDelayWithServerHint(null, 1, mid)).toBe(2);
    expect(backoff.retryDelayWithServerHint(0, 1, mid)).toBe(2);
  });
});
