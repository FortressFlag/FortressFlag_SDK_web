/**
 * A flag's value: the contract-v2 union (backend ADR-0008, published in
 * `FortressFlag_Standards/contracts/contract-v2.md`).
 *
 * A flag has an immutable KIND — boolean, string or number — and every value it ever serves
 * is a bare scalar of that kind. There are deliberately no objects or arrays: evaluated
 * payloads are readable by anyone holding the customer's page, and structured payloads would
 * force a schema conversation between page versions that a flag should never require.
 *
 * Under contract v1 every value was a boolean; a v1 payload decodes into boolean cases,
 * which is what lets a pre-v2 cache entry load unchanged after an SDK upgrade.
 */
export type FlagValue =
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "string"; readonly value: string }
  /** Numbers are float64 on the wire, exactly as the server serves them. */
  | { readonly kind: "number"; readonly value: number };

export function boolFlag(value: boolean): FlagValue {
  return { kind: "boolean", value };
}

export function stringFlag(value: string): FlagValue {
  return { kind: "string", value };
}

export function numberFlag(value: number): FlagValue {
  return { kind: "number", value };
}

/**
 * The boolean, or null when this value is not a boolean. `isEnabled` uses this for its kind
 * projection: a non-boolean value resolves to the caller's default — never a coercion and
 * never an error (Founding §8.1).
 */
export function boolValueOf(value: FlagValue): boolean | null {
  return value.kind === "boolean" ? value.value : null;
}

export function stringValueOf(value: FlagValue): string | null {
  return value.kind === "string" ? value.value : null;
}

export function numberValueOf(value: FlagValue): number | null {
  return value.kind === "number" ? value.value : null;
}

export function flagValuesEqual(a: FlagValue, b: FlagValue): boolean {
  return a.kind === b.kind && a.value === b.value;
}
