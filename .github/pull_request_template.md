<!--
Keep the PR description honest and specific. State non-obvious tradeoffs and which pillar they
serve: Security → Compliance → Efficiency → Cost (Founding CLAUDE.md §2).
-->

## What & why

## Compliance & security review

<!--
This block is not paperwork. SOC 2 Type II is graded by sampling real changes and asking for
evidence that review happened; GDPR expects data-protection questions to be asked at design time,
not at incident time. Answering here is what turns "we review changes" from a claim into a record.

This repository deserves the sharpest version of these questions. It is a component that runs
inside our customers' own websites, on end users' machines, where we cannot ship a fix on our
own schedule — customers rebuild and redeploy on theirs. And it owns the device identifier,
which Founding §6.1 classifies as pseudonymous personal data and which is simultaneously the
linchpin of the billing model — stored, on this platform, where the page's own JavaScript can
read it (the browser honesty notes in the Standards contract are the reference).

Tick every box that applies — or tick the last one. A block with nothing ticked is an unfinished
PR, not a PR with nothing to declare: that is the whole point of the last box.
-->

- [ ] **Device identity** — touches how the device ID is derived, stored, persisted, or reset
      (Founding §6.1; `FortressFlag_Standards/contracts/device-identity.md`). _It must be
      random-minted, never derived from fingerprinting, cookies, or any browser identifier. It
      is pseudonymous personal data, not an anonymous token._
- [ ] **Personal data** — collects, stores, transmits, or logs anything about the end user beyond
      what the customer explicitly configures (Founding §7.3, CLAUDE.md).
- [ ] **Browser storage** — changes what the SDK persists via `localStorage` (or any other
      storage API), or under which keys. _Cached flag values are a correctness feature (§8.4);
      anything beyond them needs justifying — and everything stored is origin-scoped and
      JS-readable by design, stated rather than papered over._
- [ ] **Network surface** — changes what the SDK sends, to where, or how often. _The SDK receives
      only its own device's values — never the full ruleset, never another device's data._
- [ ] **Host-page impact** — could affect the host page's stability, load time, bundle size,
      main-thread work, or globals (nothing beyond the one export). _A flagging outage must
      never break a customer's page (§8.1); the bundle rides the 10 kB gzip ceiling (ADR-0014)._
- [ ] **Public API** — changes the SDK's public surface. _Backward compatibility on public SDK
      APIs is sacred (§8.3). We cannot recall a shipped version._
- [ ] **None of the above.** I checked, and this change touches none of them.

<!-- For every box ticked above, answer here: what changed, which control covers it, and what you
     updated. Device-identity and personal-data changes also update
     docs/compliance/data-inventory.md in FortressFlag_Backend. -->

## Fallback behaviour

<!--
Founding §8.4 mandates the cascade: last recorded value, then `false`. If this change touches
resolution, caching, or any error path, state how the cascade still holds — including on first
load with no connectivity, after a page reload, and when localStorage is unavailable (private
mode, disabled storage, SSR).
-->

## Testing

<!-- What you ran and what it proved, including offline and cold-start paths where relevant.
     Storage behaviour is proven in the real-browser lane, never jsdom. -->

## Tradeoffs

<!-- What this gives up, and why that is the right call. Delete if genuinely none. -->
