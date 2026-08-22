import { decodeBase64Url, encodeBase64Url } from "../support/base64url.js";

// The device-identity format: the cross-platform contract in
// `FortressFlag_Standards/contracts/device-identity.md` (Founding §6.1 — the billing
// primitive, and a GDPR pseudonymous identifier).
//
// `dev_` + unpadded base64url of 16 bytes from `crypto.getRandomValues` — or `sim_` with the
// identical body when the browser declares itself automated. Random, never derived: not a
// fingerprint, not a cookie, not any browser identifier — and not a hash of one, whose input
// space is small enough to enumerate, making the "one-way" function reversible in practice.

export const DEV_PREFIX = "dev_";
export const SIM_PREFIX = "sim_";
const BODY_LENGTH = 22; // unpadded base64url of 16 bytes
const ENTROPY_BYTES = 16;

/**
 * Whether [value] is shaped like an identity we minted. BOTH prefixes are accepted
 * regardless of which one this context mints: a stored `dev_` identity later read under
 * automation is kept, because identity stability wins over prefix purity. Anything else is
 * treated as absent rather than trusted — adopting a corrupt or foreign value puts junk in
 * the billing path.
 */
export function isWellFormedDeviceId(value: string): boolean {
  let body: string;
  if (value.startsWith(DEV_PREFIX)) {
    body = value.substring(DEV_PREFIX.length);
  } else if (value.startsWith(SIM_PREFIX)) {
    body = value.substring(SIM_PREFIX.length);
  } else {
    return false;
  }
  if (body.length !== BODY_LENGTH) return false;
  const decoded = decodeBase64Url(body);
  if (decoded === null || decoded.length !== ENTROPY_BYTES) return false;
  // Strict canonical check: the server decodes with Go's Strict(), which rejects a final
  // character whose low bits are non-zero (a 22-char body only round-trips when the 22nd
  // char is A/Q/g/w …). `atob` is lenient there, so re-encode and compare — a value that
  // passes here is a value the server will not 400.
  return encodeBase64Url(decoded) === body;
}

/**
 * Best-effort automation detection (the contract's own words: compile-time-exact on iOS,
 * best-effort on Android and on the web). The browser itself sets the read-only
 * `navigator.webdriver` under Playwright/Selenium/Puppeteer/Cypress — the environment
 * declares itself, zero customer setup. The server serves `sim_` identities flags normally,
 * excludes them from seat metering, and tallies sim traffic to spot builds that lie — so a
 * stealth plugin that hides the flag bills automation as `dev_`: a billing skew in our
 * favour, not an outage.
 */
export function isAutomatedBrowser(): boolean {
  return typeof navigator !== "undefined" && navigator.webdriver === true;
}

/** Mints a fresh identity with the prefix this context calls for. */
export function mintDeviceId(simulator: boolean = isAutomatedBrowser()): string {
  const bytes = new Uint8Array(ENTROPY_BYTES);
  crypto.getRandomValues(bytes);
  return (simulator ? SIM_PREFIX : DEV_PREFIX) + encodeBase64Url(bytes);
}
