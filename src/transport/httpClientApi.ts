import { SDK_VERSION } from "../buildInfo.js";
import type { ResolvedConfiguration } from "../configuration.js";
import { LOOPBACK_HOSTS, hostOf } from "../configuration.js";
import type { Log } from "../support/log.js";
import { SUPPORTED_CONTRACT_VERSION } from "./envelope.js";
import type { ClientApi, FetchOutcome, TransportFailure } from "./clientApi.js";
import { TAGS_HEADER_NAME } from "../tags/tags.js";

/**
 * Hard ceiling on a response body: 1 MiB, shared with the cache's bound. A payload is
 * kilobytes; anything approaching this is a server that is broken or hostile, and buffering
 * it would be our memory problem inside someone else's page.
 */
export const MAX_RESPONSE_BYTES = 1 << 20;

/** The production fetch, bound so it survives being passed around (fetch is this-sensitive). */
const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

/**
 * The real client transport: one GET, via the platform's own `fetch` — a third-party HTTP
 * stack inside someone else's page is supply-chain surface the fetch does not need
 * (ADR-0014; Founding §8.1).
 *
 * Everything here is defensive against a server we do not control — which, on the data
 * plane, includes a CDN edge and whatever a hostile network puts in front of it.
 */
export class HttpClientApi implements ClientApi {
  constructor(
    private readonly configuration: ResolvedConfiguration,
    private readonly log: Log,
    /** Injected in tests to intercept the request; production uses the platform's. */
    private readonly fetchFn: typeof fetch = defaultFetch,
  ) {}

  async fetchFlags(
    deviceId: string,
    etag: string | null,
    tags: string | null,
  ): Promise<FetchOutcome> {
    const url = this.requestUrl();
    if (url === null) return { type: "failure", failure: { code: "badRequestUrl" } };

    // Belt and braces over validateConfiguration: that runs at start-up and only logs; this
    // is the check that actually stops a plaintext request leaving the browser, because a
    // caller who ignored the warning must still not be able to put an SDK key on the wire
    // in the clear.
    if (!this.transportAcceptable(url)) {
      this.log.error(`refusing to send an SDK key over plaintext HTTP to ${hostOf(url)}`);
      return { type: "failure", failure: { code: "insecureTransportRefused" } };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.configuration.requestTimeoutSeconds * 1000);

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.configuration.sdkKey}`,
        "X-FF-Device": deviceId,
        "X-FF-SDK": `web/${SDK_VERSION}`,
        Accept: "application/json",
      };
      if (tags !== null) {
        // Already validated, merged and base64url-encoded (encodeTags); header-safe by
        // construction.
        headers[TAGS_HEADER_NAME] = tags;
      }
      if (etag !== null) {
        headers["If-None-Match"] = etag;
      }

      const response = await this.fetchFn(url, {
        method: "GET",
        headers,
        signal: controller.signal,
        // We keep our own durable cache and re-verify it on load; a second, unverified copy
        // in the browser's HTTP cache would be flag state nobody checks.
        cache: "no-store",
        // Never followed: a redirect on this API is a misconfiguration or an attack, and
        // following one could replay the Authorization header somewhere it was not sent.
        redirect: "manual",
      });

      const statusMapped = this.statusOutcome(response);
      if (statusMapped !== null) return statusMapped;

      // Declared length checked before a byte is read, so an obviously oversized response
      // costs nothing. The streaming cap below is what actually enforces the limit, because
      // Content-Length is a claim, not a promise.
      const declared = Number(response.headers.get("Content-Length") ?? "0");
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        return { type: "failure", failure: { code: "responseTooLarge" } };
      }

      const raw = await readCapped(response);
      if (raw === null) return { type: "failure", failure: { code: "responseTooLarge" } };

      // Readable cross-origin only because the backend exposes it (ADR-0014).
      return { type: "success", raw, etag: response.headers.get("ETag") };
    } catch (error) {
      return { type: "failure", failure: classify(error) };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Maps a response status to an outcome, or null when the body still has to be read. */
  private statusOutcome(response: Response): FetchOutcome | null {
    if (response.type === "opaqueredirect") {
      // redirect: "manual" surfaces a redirect as an opaque response; it is never followed.
      return { type: "failure", failure: { code: "unexpectedStatus", status: 0 } };
    }
    const status = response.status;
    if (status === 200) return null;
    if (status === 304) {
      // A 304 is a successful conversation with the server — FetchOutcome "notModified"
      // documents why that distinction matters.
      return { type: "notModified" };
    }
    if (status === 401 || status === 403) {
      this.log.error(
        `The client API rejected this SDK key (HTTP ${status}). Flags will continue to ` +
          `resolve from the last cached values. Check that the key is for the ` +
          `'${this.configuration.environment.key}' environment and has not been revoked.`,
      );
      return { type: "failure", failure: { code: "unauthorized" } };
    }
    if (status === 429) {
      return {
        type: "failure",
        failure: { code: "rateLimited", retryAfterSeconds: retryAfterSeconds(response) },
      };
    }
    if (status >= 500 && status <= 599) {
      return { type: "failure", failure: { code: "serverError", status } };
    }
    return { type: "failure", failure: { code: "unexpectedStatus", status } };
  }

  private requestUrl(): string | null {
    try {
      const base = this.configuration.baseUrl.replace(/\/+$/, "");
      const url = `${base}/v1/client/flags?environment=${this.configuration.environment.key}&v=${SUPPORTED_CONTRACT_VERSION}`;
      new URL(url); // shape check only
      return url;
    } catch {
      return null;
    }
  }

  private transportAcceptable(url: string): boolean {
    const scheme = url.substring(0, url.indexOf("://")).toLowerCase();
    if (scheme === "https") return true;
    if (scheme !== "http") return false;
    const host = hostOf(url);
    if (!LOOPBACK_HOSTS.has(host)) return false;
    this.log.warning(`sending a plaintext request to ${host} — development only`);
    return true;
  }
}

/** Reads at most [MAX_RESPONSE_BYTES]; null when the stream exceeds it — abandoning the
 * read stops a server streaming forever from costing bandwidth as well as memory. */
async function readCapped(response: Response): Promise<Uint8Array | null> {
  const body = response.body;
  if (body === null) {
    // No streaming body (some test doubles, empty responses): fall back to a buffered read,
    // still bounded by the declared-length check above and the copy below.
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.length > MAX_RESPONSE_BYTES ? null : buffer;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * `Retry-After` as seconds. Only the delta-seconds form is honoured; the HTTP-date form is
 * ignored rather than parsed against a machine clock we already know may be wrong. The
 * backoff clamps whatever this returns to its cap.
 */
function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("Retry-After")?.trim();
  if (raw === undefined || raw.length === 0) return null;
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const seconds = Number(raw);
  return seconds > 0 ? seconds : null;
}

function classify(error: unknown): TransportFailure {
  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "timedOut" };
  }
  if (error instanceof TypeError) {
    // fetch's one visible network-failure shape: DNS, refused connection, CORS, offline.
    return { code: "offline" };
  }
  const description = error instanceof Error ? error.name : "unknown";
  return { code: "other", description };
}
