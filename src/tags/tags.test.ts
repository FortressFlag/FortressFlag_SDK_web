import { describe, expect, it } from "vitest";
import { decodeBase64Url } from "../support/base64url.js";
import { Log } from "../support/log.js";
import { RESERVED_TAG_KEYS, builtinTags } from "./builtinTags.js";
import { encodeTags, sanitizeTags } from "./tags.js";

const log = new Log("silent", "test");

function decodeHeader(header: string | null): Record<string, string> {
  expect(header).not.toBeNull();
  const bytes = decodeBase64Url(header ?? "");
  expect(bytes).not.toBeNull();
  return JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())) as Record<string, string>;
}

describe("sanitizeTags", () => {
  it("drops malformed keys, reserved collisions, and oversize values", () => {
    const kept = sanitizeTags(
      {
        cohort: "beta",
        "bad key!": "x",
        platform: "spoofed",
        appVersion: "9.9.9",
        big: "x".repeat(257),
      },
      RESERVED_TAG_KEYS,
      log,
    );
    expect(kept).toEqual({ cohort: "beta" });
  });

  it("measures value size in bytes, not characters", () => {
    // 129 two-byte characters: 129 chars but 258 bytes — over the 256-byte cap.
    const kept = sanitizeTags({ wide: "é".repeat(129) }, RESERVED_TAG_KEYS, log);
    expect(kept).toEqual({});
  });
});

describe("encodeTags", () => {
  it("merges built-ins over customs with sorted keys, deterministically", () => {
    const first = encodeTags(builtinTags(), { zebra: "z", alpha: "a" }, log);
    const second = encodeTags(builtinTags(), { alpha: "a", zebra: "z" }, log);
    // Same tags, different insertion order — identical bytes, or the ETag design (M3) sees
    // a different request per construction order.
    expect(first).toBe(second);
    const decoded = decodeHeader(first);
    expect(Object.keys(decoded)).toEqual(["alpha", "platform", "sdkVersion", "zebra"]);
    expect(decoded["platform"]).toBe("web");
  });

  it("survives multibyte tag values — the btoa trap", () => {
    // btoa("🚀") throws; the TextEncoder-first path must not.
    const header = encodeTags({}, { rocket: "🚀 β émoji" }, log);
    expect(decodeHeader(header)["rocket"]).toBe("🚀 β émoji");
  });

  it("returns null when there is nothing to send — an absent header means no tags", () => {
    expect(encodeTags({}, {}, log)).toBeNull();
  });

  it("sheds custom tags from the end of sorted order over the count cap", () => {
    const custom: Record<string, string> = {};
    for (let i = 0; i < 40; i++) custom[`k${String(i).padStart(2, "0")}`] = "v";
    const decoded = decodeHeader(encodeTags(builtinTags(), custom, log));
    // 32 total: 2 built-ins + 30 customs, the LAST sorted customs shed first.
    expect(Object.keys(decoded)).toHaveLength(32);
    expect(decoded["platform"]).toBe("web");
    expect(decoded["k29"]).toBe("v");
    expect(decoded["k30"]).toBeUndefined();
  });

  it("sheds custom tags over the document cap, built-ins always survive", () => {
    const custom: Record<string, string> = {};
    for (let i = 0; i < 20; i++) custom[`key${String(i).padStart(2, "0")}`] = "x".repeat(250);
    const decoded = decodeHeader(encodeTags(builtinTags(), custom, log));
    expect(decoded["platform"]).toBe("web");
    expect(decoded["sdkVersion"]).toBeDefined();
    expect(Object.keys(decoded).length).toBeLessThan(22);
  });
});
