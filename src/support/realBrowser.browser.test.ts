import { afterEach, describe, expect, it } from "vitest";

// The lane's own smoke test: proves the browser CI job runs against a REAL browser from day
// one, so the identity and cache suites that arrive by later PRs land in a lane that already
// works. jsdom would pass a fake version of all three assertions — that is exactly why this
// lane exists.
describe("real-browser lane", () => {
  afterEach(() => {
    localStorage.removeItem("fortressflag.lane.smoke");
  });

  it("has a real, persistent localStorage", () => {
    localStorage.setItem("fortressflag.lane.smoke", "yes");
    expect(localStorage.getItem("fortressflag.lane.smoke")).toBe("yes");
  });

  it("declares itself as automation (navigator.webdriver), the sim_ signal", () => {
    // Playwright drives this browser, so the browser itself must say so — the exact
    // mechanism the SDK's identity module relies on to mint sim_ (ADR-0014).
    expect(navigator.webdriver).toBe(true);
  });
});
