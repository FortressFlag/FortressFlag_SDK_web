import { encodeBase64Url } from "../support/base64url.js";

// Shared fixture for the verifier, transport and chaos suites: one well-formed envelope
// whose every field a test can override into hostility. Test-only — excluded from the build
// (tsconfig.build.json) so fixture bytes never ship in the SDK.

export const FIXTURE_NOW_MILLIS = Date.parse("2026-08-19T09:00:00Z");
export const FIXTURE_DEVICE = "dev_AAAAAAAAAAAAAAAAAAAAAA";

const encoder = new TextEncoder();

export interface PayloadOverrides {
  version?: number;
  tenant?: string;
  environment?: string;
  device?: string;
  issuedAt?: string;
  expiresAt?: string;
  /** Raw JSON text for the flags object, so tests can inject union violations. */
  flagsJson?: string;
}

export function payloadJson(overrides: PayloadOverrides = {}): string {
  const version = overrides.version ?? 2;
  const tenant = overrides.tenant ?? "11111111-1111-1111-1111-111111111111";
  const environment = overrides.environment ?? "dev";
  const device = overrides.device ?? FIXTURE_DEVICE;
  const issuedAt = overrides.issuedAt ?? "2026-08-19T08:59:00Z";
  const expiresAt = overrides.expiresAt ?? "2026-08-19T09:30:00Z";
  const flagsJson = overrides.flagsJson ?? `{"dark-mode":true,"beta":false}`;
  return (
    `{"v":${version},"tenant":${JSON.stringify(tenant)},` +
    `"environment":${JSON.stringify(environment)},"device":${JSON.stringify(device)},` +
    `"issuedAt":${JSON.stringify(issuedAt)},"expiresAt":${JSON.stringify(expiresAt)},` +
    `"flags":${flagsJson}}`
  );
}

/** A wire envelope wrapping [payload]. `sig` undefined omits the field entirely. */
export function envelopeBytes(payload: string = payloadJson(), sig?: string | null): Uint8Array {
  const encoded = encodeBase64Url(encoder.encode(payload));
  const sigPart = sig === undefined || sig === null ? "" : `,"sig":${JSON.stringify(sig)}`;
  return encoder.encode(`{"payload":${JSON.stringify(encoded)}${sigPart}}`);
}
