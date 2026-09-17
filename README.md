# FortressFlag Web SDK

FortressFlag's web client SDK — zero-dependency TypeScript, fail-safe flag resolution for a
single browser context (backend ADR-0014). It implements the contracts published in
[`FortressFlag_Standards`](https://github.com/FortressFlag/FortressFlag_Standards).

## The promise

**No call in this API throws, and no promise from it rejects.** A FortressFlag outage, a dead
network, an ad blocker, a revoked key, a corrupt cache — all of them resolve to a flag value
and none of them reach your code as an error. Resolution order (the fail-safe cascade):

1. the most recent value fetched from FortressFlag
2. the last value this browser recorded, from the durable cache
3. the default you passed, if any
4. `false`

## Honesty notes, up front

- **The device identity lives in `localStorage`** (`fortressflag.device.v1`), scoped to your
  origin. It is pseudonymous and random-minted — and readable by your page's own JavaScript,
  the same class of value as the SDK key beside it. Private windows and cleared site data mint
  new identities; one person on your website, iOS app, and Android app counts as up to three
  devices. The full contract: `FortressFlag_Standards/contracts/device-identity.md`.
- **Automation is served but never billed:** browsers driven by Playwright, Selenium,
  Puppeteer, or Cypress declare themselves via `navigator.webdriver`, and the SDK mints a
  `sim_` identity there.
- **Tags:** the SDK sends `platform` (`"web"`) and `sdkVersion` automatically. There is no
  reliable `appVersion`/`appBuild`/`osVersion` for a page, so those built-ins do not exist on
  web — a targeting rule on `appVersion` simply never matches a browser, by the contract's
  absent-tag semantics. That is documented behaviour, not a bug.
- **Every payload is signature-verified in the browser** (Ed25519 over the exact bytes,
  backend ADR-0025) against the production key shipped in the SDK, so a compromised network or
  CDN cannot feed your page values FortressFlag did not sign; the cache is stored signed and
  re-verified on load. Verification uses WebCrypto, which needs **Safari 17+, Chrome 137+ or
  Firefox 130+**. A browser without WebCrypto Ed25519 — or an insecure non-localhost origin,
  where `crypto.subtle` does not exist — cannot verify at all: the SDK reports
  `signatureUnverifiable` once at error and keeps serving cached values and your defaults
  rather than clearing anything. Local development against a backend running without signing
  keys uses `signaturePolicy: SIGNATURE_DISABLED` explicitly.
- **Ad blockers and privacy extensions** may block requests to flag domains. The cascade
  already answers: cached values keep serving, and a browser that never fetched serves your
  defaults. "Flags don't update with uBlock enabled" is that, not an SDK bug.

## Development

Node 24 (`.nvmrc`), pnpm via Corepack. Local gate:

```sh
pnpm install
pnpm build && pnpm lint && pnpm test
pnpm exec playwright install chromium && pnpm test:browser   # the real-browser lane
```

Zero runtime dependencies, enforced by policy and `pnpm audit`; 10 kB gzip ceiling, enforced
by the size gate inside `pnpm build`. See `CLAUDE.md` for the rules that bind this repo.
