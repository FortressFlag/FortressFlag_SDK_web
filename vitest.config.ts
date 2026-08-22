import { defineConfig } from "vitest/config";

// The unit lane: pure logic, no browser APIs. Anything that touches localStorage or other
// real browser behaviour lives in *.browser.test.ts and runs in the real-browser lane
// (vitest.browser.config.ts) — jsdom's localStorage is a polite fake, and a stub would test
// our idea of the browser rather than the browser.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.browser.test.ts", "node_modules/**"],
    environment: "node",
  },
});
