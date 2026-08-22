import { defineConfig } from "vitest/config";

// The real-browser lane: identity and cache tests run against REAL localStorage in a real
// chromium via Playwright, never jsdom's fake — quota behaviour, the cross-tab `storage`
// event, and private-mode throwing do not exist in a polyfill (the Keystore/keychain rule
// from the mobile SDKs, with a JS accent).
export default defineConfig({
  test: {
    include: ["src/**/*.browser.test.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: "playwright",
      screenshotFailures: false,
      instances: [{ browser: "chromium" }],
    },
  },
});
