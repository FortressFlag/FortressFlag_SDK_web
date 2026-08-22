import { describe, expect, it } from "vitest";
import { Environment, SIGNATURE_DISABLED, resolveConfiguration } from "../configuration.js";
import { Log } from "../support/log.js";
import { HttpClientApi, MAX_RESPONSE_BYTES } from "./httpClientApi.js";

const log = new Log("silent", "test");

function api(fetchFn: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new HttpClientApi(
    resolveConfiguration({
      sdkKey: "ffc_dev_k",
      environment: Environment.DEVELOPMENT,
      baseUrl: "https://edge.example.com",
      signaturePolicy: SIGNATURE_DISABLED,
      ...overrides,
    }),
    log,
    fetchFn,
  );
}

function respondWith(response: Response, capture?: { url?: string; init?: RequestInit }) {
  const fetchFn: typeof fetch = (input, init) => {
    if (capture) {
      capture.url = String(input);
      capture.init = init;
    }
    return Promise.resolve(response);
  };
  return fetchFn;
}

describe("HttpClientApi — request shape", () => {
  it("sends the contract's URL, headers, and cache mode", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const outcome = await api(respondWith(new Response("{}"), capture)).fetchFlags(
      "dev_AAAAAAAAAAAAAAAAAAAAAA",
      '"etag-1"',
      "dGFncw",
    );

    expect(outcome.type).toBe("success");
    expect(capture.url).toBe("https://edge.example.com/v1/client/flags?environment=dev&v=2");
    const headers = capture.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ffc_dev_k");
    expect(headers["X-FF-Device"]).toBe("dev_AAAAAAAAAAAAAAAAAAAAAA");
    expect(headers["X-FF-SDK"]).toMatch(/^web\/\d+\.\d+\.\d+$/);
    expect(headers["Accept"]).toBe("application/json");
    expect(headers["If-None-Match"]).toBe('"etag-1"');
    expect(headers["X-FF-Tags"]).toBe("dGFncw");
    expect(capture.init?.cache).toBe("no-store");
    expect(capture.init?.redirect).toBe("manual");
  });

  it("omits If-None-Match and X-FF-Tags when there is nothing to send", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    await api(respondWith(new Response("{}"), capture)).fetchFlags("dev_A", null, null);
    const headers = capture.init?.headers as Record<string, string>;
    expect("If-None-Match" in headers).toBe(false);
    expect("X-FF-Tags" in headers).toBe(false);
  });

  it("refuses plaintext to a non-loopback host — the SDK key never rides HTTP in the clear", async () => {
    let called = false;
    const fetchFn: typeof fetch = () => {
      called = true;
      return Promise.resolve(new Response("{}"));
    };
    const outcome = await api(fetchFn, { baseUrl: "http://example.com" }).fetchFlags(
      "dev_A",
      null,
      null,
    );
    expect(outcome).toEqual({
      type: "failure",
      failure: { code: "insecureTransportRefused" },
    });
    expect(called).toBe(false);
  });

  it("allows plaintext to loopback — the whole local-dev story", async () => {
    const outcome = await api(respondWith(new Response("{}")), {
      baseUrl: "http://localhost:8080",
    }).fetchFlags("dev_A", null, null);
    expect(outcome.type).toBe("success");
  });
});

describe("HttpClientApi — status mapping", () => {
  async function outcomeFor(response: Response) {
    return api(respondWith(response)).fetchFlags("dev_A", null, null);
  }

  it("maps 200 to success and reads the ETag response header", async () => {
    const outcome = await outcomeFor(
      new Response(`{"payload":"x"}`, { headers: { ETag: '"env-42"' } }),
    );
    expect(outcome).toMatchObject({ type: "success", etag: '"env-42"' });
    if (outcome.type === "success") {
      expect(new TextDecoder().decode(outcome.raw)).toBe(`{"payload":"x"}`);
    }
  });

  it("maps 304 to notModified — a successful conversation, not a failure", async () => {
    expect(await outcomeFor(new Response(null, { status: 304 }))).toEqual({
      type: "notModified",
    });
  });

  it("maps 401/403 to unauthorized", async () => {
    for (const status of [401, 403]) {
      expect(await outcomeFor(new Response("denied", { status }))).toEqual({
        type: "failure",
        failure: { code: "unauthorized" },
      });
    }
  });

  it("maps 429 with delta-seconds Retry-After; ignores the HTTP-date form", async () => {
    expect(
      await outcomeFor(new Response("slow down", { status: 429, headers: { "Retry-After": "7" } })),
    ).toEqual({ type: "failure", failure: { code: "rateLimited", retryAfterSeconds: 7 } });
    expect(
      await outcomeFor(
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" },
        }),
      ),
    ).toEqual({ type: "failure", failure: { code: "rateLimited", retryAfterSeconds: null } });
  });

  it("maps 5xx to serverError and anything else to unexpectedStatus", async () => {
    expect(await outcomeFor(new Response("boom", { status: 503 }))).toEqual({
      type: "failure",
      failure: { code: "serverError", status: 503 },
    });
    expect(await outcomeFor(new Response("teapot", { status: 418 }))).toEqual({
      type: "failure",
      failure: { code: "unexpectedStatus", status: 418 },
    });
  });
});

describe("HttpClientApi — defence", () => {
  it("rejects a response whose declared length exceeds the cap without reading it", async () => {
    const response = new Response("tiny", {
      headers: { "Content-Length": String(MAX_RESPONSE_BYTES + 1) },
    });
    expect(await api(respondWith(response)).fetchFlags("dev_A", null, null)).toEqual({
      type: "failure",
      failure: { code: "responseTooLarge" },
    });
  });

  it("caps a streamed body that lies about its size", async () => {
    const chunk = new Uint8Array(64 * 1024);
    let pushed = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pushed > MAX_RESPONSE_BYTES + chunk.length) {
          controller.close();
          return;
        }
        pushed += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const outcome = await api(respondWith(new Response(stream))).fetchFlags("dev_A", null, null);
    expect(outcome).toEqual({ type: "failure", failure: { code: "responseTooLarge" } });
  });

  it("maps an aborted request to timedOut", async () => {
    const fetchFn: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const outcome = await api(fetchFn, { requestTimeoutSeconds: 0.01 }).fetchFlags(
      "dev_A",
      null,
      null,
    );
    expect(outcome).toEqual({ type: "failure", failure: { code: "timedOut" } });
  });

  it("maps fetch's TypeError to offline", async () => {
    const fetchFn: typeof fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    expect(await api(fetchFn).fetchFlags("dev_A", null, null)).toEqual({
      type: "failure",
      failure: { code: "offline" },
    });
  });

  it("never throws — an unexpected error becomes an outcome", async () => {
    const fetchFn: typeof fetch = () => Promise.reject(new RangeError("weird"));
    expect(await api(fetchFn).fetchFlags("dev_A", null, null)).toEqual({
      type: "failure",
      failure: { code: "other", description: "RangeError" },
    });
  });
});
