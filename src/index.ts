// The public surface, re-exported from one place so "what is public" is one file's diff.
// Backward compatibility on everything exported here is sacred (Founding §8.3) — we cannot
// recall a shipped SDK.
export { SDK_VERSION } from "./buildInfo.js";
export {
  Environment,
  TrustedKeys,
  SIGNATURE_DISABLED,
  signatureRequired,
  DEFAULT_BASE_URL,
  MINIMUM_REFRESH_INTERVAL_SECONDS,
} from "./configuration.js";
export type { Configuration, ConfigurationProblem, SignaturePolicy } from "./configuration.js";
export { validateConfiguration, resolveConfiguration } from "./configuration.js";
export type { FlagValue } from "./flagValue.js";
export type {
  Diagnostics,
  RefreshFailure,
  RefreshOutcome,
  Resolution,
  ValueSource,
} from "./resolution.js";
export type { LogPolicy } from "./support/log.js";
export { FortressFlag } from "./fortressFlag.js";
export type { Unsubscribe } from "./fortressFlag.js";
