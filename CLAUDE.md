# FortressFlag_SDK_web — Agent & Contributor Guide

> **This repo inherits the FortressFlag founding principles.** The canonical, source-of-truth
> document lives in the backend repo (`FortressFlag_Backend/CLAUDE.md`, the founding document).
> Read it before making architectural or design decisions.
>
> ADR-nnnn refers to FortressFlag's internal architecture decision records. The public contract
> every SDK implements is `FortressFlag_Standards`; decision records are not published.
>
> When anything here conflicts with the founding document, the founding document wins.
> Priority order when in doubt: **Security → Compliance → Efficiency → Cost.**

## This repo

The **web client SDK** — FortressFlag's third client SDK (backend ADR-0014). It runs on a
customer's own website, on an origin we do not control, inside a page whose stability is the
customer's product. It implements the contracts published in
[`FortressFlag_Standards`](https://github.com/FortressFlag/FortressFlag_Standards)
(`contracts/contract-v1.md`, `contract-v2.md`, `device-identity.md`) — owned by
`FortressFlag_Backend`, changed only via ADRs there.

## Non-negotiable rules (see founding doc for the full set)

### Fail-safe evaluation (Founding §8.1, §8.4)

- The SDK **never throws to the caller** and **never breaks the host page.** A flagging outage
  must be invisible to the end user's experience. In JavaScript that has a second face:
  **a rejected promise IS a throw** — every async path resolves to an outcome, and an
  unhandled rejection from this SDK inside a customer's error tracking is our crash.
  CI greps library sources for `any`, non-null assertions and `@ts-ignore`; the chaos suite
  fails on any unhandled rejection.
- **Fallback cascade, in this exact order:**
  1. **Last recorded value** — persist the most recent known-good envelope to `localStorage`
     and resolve from it on any fetch failure (offline, ad blocker, timeout, cold start).
  2. **`false`** — if no value was ever recorded for a flag, return `false` (features ship
     gated off). A developer-supplied default substitutes for this step only; the last
     recorded value always beats it.
- The local cache is a **correctness feature, not an optimization** — it must survive page
  reloads and browser restarts, and expiry governs freshness, never validity (the cache loads
  with expiry unenforced; see the contract's "expiry asymmetry").

### Data minimization (Founding §2.1, §7.3)

- The SDK **must not download the full ruleset** or any other device's data. It receives only
  the values for its own device context — one endpoint, `GET /v1/client/flags` (backend
  ADR-0004). Do not add endpoints, streaming, or ruleset access; the one-endpoint shape is
  architecture, not an omission.
- No secrets or PII in anything the SDK stores or transmits beyond what the customer
  configures. Flag values, tag values and SDK keys never appear in a console line.

### Device identity = billing (Founding §6.1)

The canonical contract is
**`FortressFlag_Standards/contracts/device-identity.md`** — this repo implements its Web
column: `dev_` (or `sim_` when `navigator.webdriver === true`) + unpadded base64url of 16
bytes from `crypto.getRandomValues`, held in `localStorage` under `fortressflag.device.v1`,
validation accepting both prefixes, adopt-on-conflict across tabs, never derived from any
fingerprint or browser identifier.

The **browser honesty notes** in that contract are binding on everything documented here:

- **The identity is JS-readable on the page.** It is pseudonymous, not secret — the same
  class as the SDK key beside it. Do not add code or docs that pretend otherwise.
- **The origin is the scope.** No cross-site linkage by construction; one person on a
  customer's website + iOS app + Android app is up to three billable devices.
- **Private windows and cleared site data mint new identities.** Platform facts, documented
  rather than papered over.
- **Automation is served, never billed:** `navigator.webdriver === true` mints `sim_` —
  best-effort, like Android's heuristics; stealth plugins skew billing in our favour, not
  the customer's.

### Zero runtime dependencies (ADR-0014)

`dependencies` in `package.json` is **empty and stays empty**. Everything the SDK needs is
platform: `fetch`, `crypto.getRandomValues`, `localStorage`. A `dependencies` entry is a
supply-chain decision the maintainer owns; **ask, don't add** — a client SDK on customers' pages is
the worst place in the system to take on supply-chain surface. devDependencies exist and are
Dependabot-watched; they never ship.

### The 10 kB ceiling (ADR-0014)

The built entry graph must gzip under **10 kB**, gated by `scripts/size-gate.mjs` inside
`pnpm build`. Shrinking code is the first answer to a red gate; raising the ceiling is a
maintainer-owned decision.

## Workflow

- Default branch: `development`. Changes go via PR with review; squash merge, linear history
  (Founding §7.5). CI is the merge gate — we cannot recall a shipped SDK.
- **Commits and PRs are authored as FortressFlag, never a personal identity.** Local commits
  carry `FortressFlag <noreply@fortressflag.com>` (a gitconfig include scoped to the
  maintainer's FortressFlag clones); PRs are opened and merged via the `fortressflag` GitHub App, because GitHub
  authors a squash commit as the PR opener's account regardless of branch authorship.
- **The public SDK API and the consumed contract are backward-compatibility sacred** (Founding
  §5, §8.3) — never break a shipped SDK.
- Local gate: `pnpm build && pnpm lint && pnpm test` (Node 24 via `.nvmrc`, pnpm via
  Corepack). The real-browser lane (`pnpm test:browser`) needs Playwright's chromium
  (`pnpm exec playwright install chromium`); CI runs it on every PR.
- Tests that touch `localStorage`, the `storage` event, or any other real browser behaviour
  are `*.browser.test.ts` and run in the real-browser lane — jsdom's localStorage is a polite
  fake, and a stub would test our idea of the browser.
