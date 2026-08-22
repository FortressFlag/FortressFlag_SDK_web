/** Why a fetch did not produce an envelope. */
export type TransportFailure =
  | { readonly code: "offline" }
  | { readonly code: "timedOut" }
  /** The SDK key was rejected or revoked. Not fatal — the cache keeps answering. */
  | { readonly code: "unauthorized" }
  | { readonly code: "rateLimited"; readonly retryAfterSeconds: number | null }
  | { readonly code: "serverError"; readonly status: number }
  | { readonly code: "unexpectedStatus"; readonly status: number }
  | { readonly code: "responseTooLarge" }
  | { readonly code: "cancelled" }
  | { readonly code: "insecureTransportRefused" }
  | { readonly code: "badRequestUrl" }
  | { readonly code: "other"; readonly description: string };

/** The result of one attempt to fetch this browser's flag values. */
export type FetchOutcome =
  /**
   * The exact response bytes, unparsed. Verification happens above this layer so that the
   * transport never has an opinion about whether a payload is trustworthy. `etag` is read
   * from the response — which works cross-origin only because the backend exposes it
   * (`Access-Control-Expose-Headers: ETag`, ADR-0014); without that the browser hides the
   * header, the SDK never sends `If-None-Match`, and every poll is a full 200 forever.
   */
  | { readonly type: "success"; readonly raw: Uint8Array; readonly etag: string | null }
  /**
   * The server confirmed our cached copy is current — **and it is a success**: it stamps
   * `lastSuccessfulFetch`, because a browser whose flags simply have not changed for a week
   * must not look, on a diagnostics panel, like one that has been failing for a week.
   */
  | { readonly type: "notModified" }
  | { readonly type: "failure"; readonly failure: TransportFailure };

/**
 * The client data-plane contract, as the SDK consumes it. An interface so the same code path
 * runs against the control plane today, the CDN edge tomorrow, and a hostile test double in
 * the chaos tests.
 *
 * `tags` is the pre-encoded `X-FF-Tags` header value, or null to send none — encoded above
 * this layer (see encodeTags) so the transport stays a dumb pipe.
 */
export interface ClientApi {
  fetchFlags(deviceId: string, etag: string | null, tags: string | null): Promise<FetchOutcome>;
}
