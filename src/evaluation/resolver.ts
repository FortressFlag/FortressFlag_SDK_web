import type { FlagValue } from "../flagValue.js";
import { flagValuesEqual } from "../flagValue.js";
import type { Resolution } from "../resolution.js";

/**
 * The fallback cascade (Founding CLAUDE.md §8.4).
 *
 * Deliberately pure — no I/O, no clock, no state. This is the most consequential logic in
 * the SDK and the piece most likely to be got subtly wrong, so it is written to be
 * exhaustively table-testable in isolation.
 *
 * The order that is easy to get wrong: **a developer-supplied default substitutes for
 * `false` only.** A value this browser actually received always beats a compiled-in guess,
 * even if that value is weeks old and the browser has been offline since. The server is the
 * authority on a flag's state; the default only answers "what if this browser has never
 * heard anything at all?".
 *
 * Within this function, a present fresh payload with the key absent falls through to the
 * cache tier. Do not design against that as a grace period: in the shipped SDK it never
 * happens across polls, because the client mirrors every accepted payload into both tiers —
 * so a key that leaves the payload leaves the cache on the same poll and resolves to the
 * developer default, else `false`. That is deliberate (backend ADR-0003): archiving a flag
 * turns the feature off on every online browser within one poll, and a cache that
 * "helpfully" preserved removed keys would make deletion unable to end a rollout.
 */
export function resolve(
  key: string,
  fresh: ReadonlyMap<string, FlagValue> | null,
  cached: ReadonlyMap<string, FlagValue> | null,
  developerDefault: FlagValue | null,
): Resolution {
  const freshValue = fresh?.get(key);
  if (freshValue !== undefined) return { value: freshValue, source: "fresh" };
  const cachedValue = cached?.get(key);
  if (cachedValue !== undefined) return { value: cachedValue, source: "cached" };
  if (developerDefault !== null) return { value: developerDefault, source: "developerDefault" };
  return { value: { kind: "boolean", value: false }, source: "safeDefault" };
}

/**
 * Effective values for every key this browser knows about — the union of the fresh and
 * cached key sets, each resolved through [resolve] so enumeration cannot drift from
 * single-key reads. No developer default participates: enumeration reports what the browser
 * *has*, and a compiled-in default is not something the browser has.
 */
export function resolveAll(
  fresh: ReadonlyMap<string, FlagValue> | null,
  cached: ReadonlyMap<string, FlagValue> | null,
): Map<string, Resolution> {
  const keys = new Set<string>();
  for (const key of fresh?.keys() ?? []) keys.add(key);
  for (const key of cached?.keys() ?? []) keys.add(key);
  const resolutions = new Map<string, Resolution>();
  for (const key of keys) {
    resolutions.set(key, resolve(key, fresh, cached, null));
  }
  return resolutions;
}

/**
 * Keys whose effective value differs between two payload states, for change notification.
 * Computed over the union of both key sets so that a flag *disappearing* from a payload is
 * evaluated too: it falls back down the cascade, which may well change its effective value.
 */
export function changedKeys(
  oldFresh: ReadonlyMap<string, FlagValue> | null,
  newFresh: ReadonlyMap<string, FlagValue> | null,
  cached: ReadonlyMap<string, FlagValue> | null,
): Set<string> {
  const keys = new Set<string>();
  for (const key of oldFresh?.keys() ?? []) keys.add(key);
  for (const key of newFresh?.keys() ?? []) keys.add(key);
  const changed = new Set<string>();
  for (const key of keys) {
    const before = resolve(key, oldFresh, cached, null);
    const after = resolve(key, newFresh, cached, null);
    if (!flagValuesEqual(before.value, after.value)) changed.add(key);
  }
  return changed;
}
