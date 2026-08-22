import { describe, expect, it } from "vitest";
import type { FlagValue } from "../flagValue.js";
import { changedKeys, resolve, resolveAll } from "./resolver.js";

const bool = (value: boolean): FlagValue => ({ kind: "boolean", value });
const str = (value: string): FlagValue => ({ kind: "string", value });
const flags = (entries: Record<string, FlagValue>) => new Map(Object.entries(entries));

describe("resolve — the cascade table", () => {
  it("fresh beats cached beats default beats false, in that order", () => {
    const fresh = flags({ k: bool(true) });
    const cached = flags({ k: bool(false) });

    expect(resolve("k", fresh, cached, bool(false))).toEqual({
      value: bool(true),
      source: "fresh",
    });
    expect(resolve("k", null, cached, bool(true))).toEqual({
      value: bool(false),
      source: "cached",
    });
    expect(resolve("k", null, null, bool(true))).toEqual({
      value: bool(true),
      source: "developerDefault",
    });
    expect(resolve("k", null, null, null)).toEqual({
      value: bool(false),
      source: "safeDefault",
    });
  });

  it("a cached value beats the developer default — the order that is easy to get wrong", () => {
    // A value this browser actually received always beats a compiled-in guess, however old.
    const cached = flags({ k: bool(false) });
    expect(resolve("k", null, cached, bool(true)).source).toBe("cached");
  });

  it("a key absent from a present fresh payload falls through to the cache tier", () => {
    const fresh = flags({ other: bool(true) });
    const cached = flags({ k: str("hello") });
    expect(resolve("k", fresh, cached, null)).toEqual({ value: str("hello"), source: "cached" });
  });
});

describe("resolveAll", () => {
  it("enumerates the union of both tiers with per-key cascade, no developer default", () => {
    const fresh = flags({ a: bool(true) });
    const cached = flags({ a: bool(false), b: str("s") });
    const all = resolveAll(fresh, cached);
    expect(all.size).toBe(2);
    expect(all.get("a")).toEqual({ value: bool(true), source: "fresh" });
    expect(all.get("b")).toEqual({ value: str("s"), source: "cached" });
  });

  it("is empty when the browser has never heard anything", () => {
    expect(resolveAll(null, null).size).toBe(0);
  });
});

describe("changedKeys", () => {
  it("reports keys whose effective value moved, including disappearances", () => {
    const oldFresh = flags({ a: bool(true), gone: bool(true) });
    const newFresh = flags({ a: bool(false) });
    // With no cache behind it, `gone` falls to safeDefault false — an effective change.
    const changed = changedKeys(oldFresh, newFresh, null);
    expect(changed).toEqual(new Set(["a", "gone"]));
  });

  it("does not report a disappearance masked by an identical cached value", () => {
    const oldFresh = flags({ gone: bool(true) });
    const cached = flags({ gone: bool(true) });
    expect(changedKeys(oldFresh, flags({}), cached)).toEqual(new Set());
  });

  it("reports nothing for identical payloads", () => {
    const same = flags({ a: bool(true), b: str("x") });
    expect(changedKeys(same, new Map(same), null)).toEqual(new Set());
  });
});
