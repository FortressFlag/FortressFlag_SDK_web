import type { LogPolicy } from "./support/log.js";

/**
 * Which of the customer's environments this page reads flags from.
 *
 * A validated value type, not a free string. The set of environments is the customer's own
 * data (they create `qa` or `eu-live` in the dashboard), but "which environment am I?" must
 * never be arbitrary text: on a product whose entire job is answering "is this on in
 * production?", a typo that silently reads the wrong environment is the worst failure mode
 * available. [Environment.of] enforces the same key format the server's
 * `environments_key_format` CHECK does (2–32 chars, lowercase letters, digits and hyphens,
 * starting and ending with a letter or digit) and returns null rather than carrying rubbish.
 */
export class Environment {
  private constructor(public readonly key: string) {}

  toString(): string {
    return this.key;
  }

  /** The seeded default every tenant starts with, key `dev`. */
  static readonly DEVELOPMENT = new Environment("dev");

  /** The seeded default with key `staging`. */
  static readonly STAGING = new Environment("staging");

  /**
   * The seeded default with key `prod`. Whether an environment is treated as production by
   * the control plane is a property of the tenant's row (`is_production`), not of this name
   * — the SDK reads whatever environment its key is scoped to.
   */
  static readonly PRODUCTION = new Environment("prod");

  /**
   * An environment the customer defined in the dashboard, or null when [key] is not shaped
   * like an environment key — null rather than acceptance, because a malformed key could
   * never name an environment on any tenant, and carrying it forward turns a build-adjacent
   * mistake into a runtime "flags silently never load".
   */
  static of(key: string): Environment | null {
    return Environment.isValidKey(key) ? new Environment(key) : null;
  }

  private static isValidKey(key: string): boolean {
    if (key.length < 2 || key.length > 32) return false;
    return /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(key);
  }
}

/**
 * Public keys the SDK will accept payload signatures from, keyed by the key ID that appears
 * in an envelope's `sig` field. Keyed rather than a bare list so that rotation is a publish,
 * not a page redeploy.
 */
export class TrustedKeys {
  public readonly keysById: ReadonlyMap<string, Uint8Array>;

  constructor(keysById: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>) {
    this.keysById = keysById instanceof Map ? new Map(keysById) : new Map(Object.entries(keysById));
  }

  get isEmpty(): boolean {
    return this.keysById.size === 0;
  }

  /**
   * The keys FortressFlag signs production payloads with (backend ADR-0025), raw 32-byte
   * Ed25519 public keys by key ID. Rotation adds key N+1 here one release before the backend
   * switches to it; the retired key leaves one release later. The same keys are published
   * in the customer docs (`concepts/payload-signing`) and ADR-0025. Production only: a
   * build that targets staging passes the staging key explicitly.
   */
  static readonly FORTRESSFLAG_PRODUCTION = new TrustedKeys({
    // prod-2026-09-k1 — base64url EaEF8MHNu3onHxemTg3-OcrKrq7ODsZIVEp-IVV2ojg (ADR-0025, minted 2026-09-16)
    "prod-2026-09-k1": hexToBytes(
      "11a105f0c1cdbb7a271f17a64e0dfe39cacaaeaece0ec648544a7e215576a238",
    ),
  });
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * How the SDK treats the signature on a flag payload.
 *
 * The default is `required`. Rejecting an unverifiable payload is safe here in a way it is
 * not in most systems: rejection means "serve the last value this browser saw", not "break
 * the page" (Founding §8.4) — so there is no availability argument for verifying loosely.
 * `disabled` accepts unsigned payloads — intended for local development against a backend
 * running without `FF_SIGNING_*`. A named, greppable choice rather than a silent
 * fallback so that "why is this not verifying?" always has an answer in the customer's own
 * source.
 */
export type SignaturePolicy =
  { readonly type: "required"; readonly trustedKeys: TrustedKeys } | { readonly type: "disabled" };

export const SIGNATURE_DISABLED: SignaturePolicy = { type: "disabled" };

export function signatureRequired(trustedKeys: TrustedKeys): SignaturePolicy {
  return { type: "required", trustedKeys };
}

/** A problem with a [Configuration], reported rather than thrown. */
export interface ConfigurationProblem {
  readonly code:
    | "emptySdkKey"
    | "sdkKeyWrongFormat"
    | "sdkKeyEnvironmentMismatch"
    | "insecureBaseUrl"
    | "signatureRequiredButNoTrustedKeys"
    | "refreshIntervalTooShort";
  readonly message: string;
}

/** Everything the SDK needs to run. Handed to `FortressFlag.start`; treated as immutable. */
export interface Configuration {
  /**
   * The client SDK key, of the form `ffc_<env>_<random>`.
   *
   * **This is not a secret.** It ships in every copy of the page and view-source recovers
   * it. It is read-only, scoped to one tenant and one environment, and revocable without a
   * redeploy. Never put a management token here — the client API will not accept one.
   *
   * It is rate-limited server-side per device and per key; either answers HTTP 429, which
   * this SDK treats as a transient failure: the fetch fails, resolution continues from the
   * durable cache, and the server's `Retry-After` feeds the backoff. Nothing is thrown to
   * your code.
   */
  readonly sdkKey: string;
  /** Which environment's values to read. */
  readonly environment: Environment;
  /** The client API base URL. Defaults to FortressFlag's edge. */
  readonly baseUrl?: string;
  /**
   * Custom tags to send with every flag fetch, fixed at start; change them at runtime with
   * `FortressFlag.setTags`. Keys are 1–64 chars of `A–Z a–z 0–9 . _ -`; values at most 256
   * bytes; at most 32 tags including the built-ins the SDK adds automatically (`platform`,
   * `sdkVersion` on web — the five built-in names are reserved on every platform). Entries
   * outside the limits are dropped with a logged warning, never an error.
   *
   * Tags transit on every request but are never stored by FortressFlag — the server
   * evaluates them statelessly and discards them. They still leave the browser: prefer
   * stable, non-identifying values, and hash anything user-derived first.
   */
  readonly tags?: Readonly<Record<string, string>>;
  /** How the SDK treats payload signatures. Defaults to required. */
  readonly signaturePolicy?: SignaturePolicy;
  /**
   * How often to poll for new values, in seconds. Jitter of ±20% is applied so a fleet of
   * browsers does not synchronise into a thundering herd against a recovering backend.
   * Note that background tabs throttle timers (≥1/minute); the SDK compensates by
   * refreshing on `visibilitychange` when the page returns.
   */
  readonly refreshIntervalSeconds?: number;
  /**
   * Per-request timeout in seconds. Short on purpose: a slow flag fetch must never become
   * the page's problem, and a timeout costs nothing because the cache answers immediately.
   */
  readonly requestTimeoutSeconds?: number;
  /** How much to log. */
  readonly logging?: LogPolicy;
}

/** [Configuration] with every default applied — what the SDK actually runs on. */
export interface ResolvedConfiguration {
  readonly sdkKey: string;
  readonly environment: Environment;
  readonly baseUrl: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly signaturePolicy: SignaturePolicy;
  readonly refreshIntervalSeconds: number;
  readonly requestTimeoutSeconds: number;
  readonly logging: LogPolicy;
}

/** FortressFlag's client API edge. */
export const DEFAULT_BASE_URL = "https://edge.fortressflag.com";

/**
 * The shortest polling interval the SDK will honour. Anything faster is the caller
 * volunteering to be rate-limited, and costs the customer money for values that did not
 * change (Founding §6). The server's per-device limit is sized with headroom over this
 * number.
 */
export const MINIMUM_REFRESH_INTERVAL_SECONDS = 30;

/**
 * The hosts a plaintext `http://` base URL is permitted for. There is no
 * `allowsInsecureLocalTransport` opt-in on web: the browser already governs transport
 * (mixed-content rules block plaintext from HTTPS pages anyway), and a plain-HTTP page
 * talking to `http://localhost:8080` is the entire local-dev story. `10.0.2.2` is
 * emulator-specific and does not join this set.
 */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function resolveConfiguration(configuration: Configuration): ResolvedConfiguration {
  return {
    sdkKey: configuration.sdkKey,
    environment: configuration.environment,
    baseUrl: configuration.baseUrl ?? DEFAULT_BASE_URL,
    tags: configuration.tags ?? {},
    signaturePolicy:
      configuration.signaturePolicy ?? signatureRequired(TrustedKeys.FORTRESSFLAG_PRODUCTION),
    refreshIntervalSeconds: configuration.refreshIntervalSeconds ?? 300,
    requestTimeoutSeconds: configuration.requestTimeoutSeconds ?? 10,
    logging: configuration.logging ?? "standard",
  };
}

/** The host of [url], ports stripped, bracketed IPv6 kept intact. */
export function hostOf(url: string): string {
  const afterScheme = url.includes("://") ? url.substring(url.indexOf("://") + 3) : "";
  const authority = afterScheme.split("/")[0] ?? "";
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    return end < 0 ? authority : authority.substring(0, end + 1);
  }
  const colon = authority.indexOf(":");
  return colon < 0 ? authority : authority.substring(0, colon);
}

/**
 * Everything wrong with this configuration.
 *
 * Returned rather than thrown, and public, so a customer can assert on it in their own test
 * suite and find the mistake at build time. `FortressFlag.start` calls this and logs, but
 * never fails the page: a page that ships with a typo'd key still loads, it just serves
 * defaults.
 */
export function validateConfiguration(
  configuration: ResolvedConfiguration,
): ConfigurationProblem[] {
  const problems: ConfigurationProblem[] = [];

  const { sdkKey, environment } = configuration;
  if (sdkKey.length === 0) {
    problems.push({ code: "emptySdkKey", message: "sdkKey is empty." });
  } else {
    // Found by index, NOT split-with-limit: the key's random part is base64url, whose
    // alphabet includes `_` — and unlike Go's SplitN, JavaScript's split(sep, limit)
    // TRUNCATES the tail rather than keeping it, so a naive port mis-rejects roughly three
    // keys in four, silently and intermittently (the backend's sdkkey.SplitN comment, in
    // its JS disguise).
    const first = sdkKey.indexOf("_");
    const second = first < 0 ? -1 : sdkKey.indexOf("_", first + 1);
    const prefix = first < 0 ? "" : sdkKey.substring(0, first);
    const keyEnvironment = second < 0 ? "" : sdkKey.substring(first + 1, second);
    const random = second < 0 ? "" : sdkKey.substring(second + 1);
    if (prefix !== "ffc" || keyEnvironment.length === 0 || random.length === 0) {
      problems.push({
        code: "sdkKeyWrongFormat",
        message: "sdkKey is not of the form ffc_<env>_<random>.",
      });
    } else if (keyEnvironment !== environment.key) {
      problems.push({
        code: "sdkKeyEnvironmentMismatch",
        message:
          `sdkKey is scoped to environment '${keyEnvironment}' but the configuration asks ` +
          `for '${environment.key}'. The server will reject this; fix the key or the environment.`,
      });
    }
  }

  const baseUrl = configuration.baseUrl;
  const scheme = baseUrl.includes("://")
    ? baseUrl.substring(0, baseUrl.indexOf("://")).toLowerCase()
    : "";
  if (scheme !== "https") {
    if (scheme === "http" && LOOPBACK_HOSTS.has(hostOf(baseUrl))) {
      // The local-dev story: plaintext to loopback only, no opt-in flag needed — the
      // browser's own mixed-content rules already stop this leaving an HTTPS page.
    } else {
      problems.push({
        code: "insecureBaseUrl",
        message: "baseUrl must use https (plaintext http is allowed for loopback hosts only).",
      });
    }
  }

  const policy = configuration.signaturePolicy;
  if (policy.type === "required" && policy.trustedKeys.isEmpty) {
    problems.push({
      code: "signatureRequiredButNoTrustedKeys",
      message:
        "signaturePolicy is required but no trusted keys were supplied, so every payload " +
        "will be rejected. Supply keys, or choose disabled explicitly for local development.",
    });
  }

  if (configuration.refreshIntervalSeconds < MINIMUM_REFRESH_INTERVAL_SECONDS) {
    // A statement of fact, not a warning about a hypothetical: the control plane counts per
    // device and answers 429.
    problems.push({
      code: "refreshIntervalTooShort",
      message:
        `refreshIntervalSeconds is below the ${MINIMUM_REFRESH_INTERVAL_SECONDS}-second ` +
        `minimum. The control plane rate-limits per device and will answer HTTP 429; the ` +
        `SDK keeps serving cached values, so the effect is stale flags rather than an error.`,
    });
  }

  return problems;
}
