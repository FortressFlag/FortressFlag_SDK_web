import { SDK_VERSION } from "../buildInfo.js";

/**
 * The tags the SDK sends automatically: mechanically derived facts about this context, none
 * of them user-identifying. All five contract names are reserved (contract v1) even though
 * the web sends only two — a customer tag colliding with any of them is dropped by
 * `sanitizeTags`, because built-ins are mechanically derived truths on every platform, and a
 * web page allowed to fake `appVersion` would make version rules lie about the platforms
 * that do send it honestly.
 */
export const RESERVED_TAG_KEYS: ReadonlySet<string> = new Set([
  "appVersion",
  "appBuild",
  "osVersion",
  "platform",
  "sdkVersion",
]);

/**
 * The live set: `platform` and `sdkVersion` only. There is no reliable
 * `appVersion`/`appBuild`/`osVersion` for a page, and the contract's absent-tag semantics
 * already handle it — a rule on `appVersion` simply never matches a browser (stated in the
 * README so nobody debugs it as a bug). Deliberately no user-agent scraping to fake an
 * osVersion: UA strings are frozen/reduced and the value would be a lie the contract does
 * not need (ADR-0014).
 */
export function builtinTags(): Record<string, string> {
  return {
    platform: "web",
    sdkVersion: SDK_VERSION,
  };
}
