# Security Policy

FortressFlag holds the switches that turn our customers' production behavior on and off. A
compromise of FortressFlag is a compromise of every customer that trusts us (Founding CLAUDE.md
§2.1). We would rather hear about a problem early and awkwardly than late and publicly.

## Reporting a vulnerability

**Use GitHub private vulnerability reporting:** open the repository's **Security** tab and choose
**Report a vulnerability**. This creates a private advisory that only maintainers can see, so a
report never sits in a public issue while it is still exploitable.

Please do not open a public issue, pull request, or discussion for a suspected vulnerability.

Helpful reports usually include: what you found, how to reproduce it, which component and version,
and what an attacker gets out of it. A rough report you send today beats a polished one you send
next month.

## What to expect

| Stage                                                   | Target                  |
| ------------------------------------------------------- | ----------------------- |
| Acknowledgement that a human has read it                | 3 business days         |
| Initial assessment and severity                         | 10 business days        |
| Fix or documented mitigation for critical/high findings | 30 days from assessment |

These are targets for a small team, stated so you know when to chase us rather than assume
silence means indifference. If a target slips, we will tell you where the work stands.

## Scope

This repository is the **web client SDK** — code that runs inside our customers' own websites,
in end users' browsers. Findings we especially want to hear about:

- **Device-identity problems.** The device ID is a pseudonymous identifier under GDPR (Founding
  §6.1; `FortressFlag_Standards/contracts/device-identity.md`). Anything that makes it derivable
  from fingerprinting, cookies, or any browser identifier — or that links it across origins —
  is a privacy finding, not a design preference. Note what is _not_ a finding here: the
  identity being readable by the page's own JavaScript is the documented design (the contract's
  browser honesty notes) — it is pseudonymous, not secret.
- **Data leaving the browser that should not.** The SDK receives only its own device's flag
  values — never the full ruleset, never another device's data. Anything that widens that is
  serious.
- **Browser-storage exposure.** Cached flag values persist across reloads by design (§8.4),
  origin-scoped. Anything that stores more than the identity and the verified envelope, or that
  makes either readable across origins, is a finding.
- **Host-page compromise or instability.** The SDK must never break the host page, throw to the
  caller, or surface an unhandled promise rejection when flagging is unavailable (§8.1). It
  must add no globals beyond its one export.
- **Ruleset or transport integrity** — anything letting an attacker feed the SDK values it
  should not accept, including via a poisoned cache.
- **Supply-chain surface.** The SDK has zero runtime dependencies by decision (ADR-0014);
  anything that quietly changes that is a finding in itself.

Two notes specific to this repo:

- **We cannot recall a shipped SDK.** A vulnerable version lives in customers' pages until they
  rebuild and redeploy, on their schedule. That makes findings here longer-lived than they look,
  and worth reporting even when they seem minor.
- **The end user is not our user.** People affected by a bug here have no relationship with us
  and did not choose us. We take reports about their privacy seriously on that basis alone.

Other components live in their own repositories, each with this policy: `FortressFlag_Backend`
(control plane), `FortressFlag_Frontend` (dashboard), `FortressFlag_Infra` (infrastructure),
`FortressFlag_SDK_ios` (iOS client SDK), `FortressFlag_SDK_android` (Android client SDK),
`FortressFlag_Standards` (contracts).

## Safe harbour

If you make a good-faith effort to follow this policy, we will not pursue legal action against you
for your research. Good faith means: you do not access, modify, or retain data belonging to anyone
but yourself; you do not degrade service for others; you stop when you have proven the issue rather
than exploring how far it goes; and you give us a reasonable chance to fix it before disclosing.

## Disclosure

We will credit reporters who want credit, and coordinate timing on a public advisory once a fix is
available.
