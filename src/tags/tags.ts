import { encodeBase64Url } from "../support/base64url.js";
import type { Log } from "../support/log.js";

/**
 * Device tags (contract v1, `X-FF-Tags`; backend ADR-0004): the values this browser reports
 * with every fetch, which the server evaluates targeting rules against. Tags are
 * request-scoped on the server by decision — evaluated and forgotten, never persisted, never
 * logged — but they still transit, so the same rule applies here as everywhere else in this
 * SDK: a tag VALUE may carry anything the customer put in it and never appears in a console
 * line. A tag KEY is the customer's own configuration, loggable when it is well-formed.
 */

/** The request header the merged tag set travels in. */
export const TAGS_HEADER_NAME = "X-FF-Tags";

/**
 * The caps, shared verbatim with the server (contract v1). The server answers 400 to a
 * violation because the SDK enforces the same caps here first — a request the server sees
 * over the caps came from a broken client.
 */
export const MAX_TAG_COUNT = 32;
export const MAX_TAG_KEY_LENGTH = 64;
export const MAX_TAG_VALUE_BYTES = 256;
export const MAX_TAG_DOCUMENT_BYTES = 4096;

const encoder = new TextEncoder();

/** 1–64 characters of `A–Z a–z 0–9 . _ -`. */
export function isValidTagKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_TAG_KEY_LENGTH) return false;
  return /^[a-zA-Z0-9._-]+$/.test(key);
}

/**
 * Validates customer-supplied tags, dropping what the contract cannot carry.
 *
 * Dropping, not throwing and not truncating: no SDK call throws (Founding §8.1), and a
 * truncated value would silently match different rules than the one the customer set. Each
 * drop logs a warning naming the KEY only — a key that itself failed the charset check is
 * arbitrary text and is logged as a placeholder instead.
 *
 * A customer key colliding with a [reserved] built-in is dropped: built-ins are mechanically
 * derived truths about the context, and letting configuration overwrite them would make the
 * rules that depend on them lie.
 */
export function sanitizeTags(
  custom: Readonly<Record<string, string>>,
  reserved: ReadonlySet<string>,
  log: Log,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(custom)) {
    if (!isValidTagKey(key)) {
      log.warning("dropping tag with a malformed key (1-64 chars of A-Za-z0-9._- required)");
      continue;
    }
    if (reserved.has(key)) {
      log.warning(`dropping tag '${key}': it collides with a built-in tag the SDK sends itself`);
      continue;
    }
    if (encoder.encode(value).length > MAX_TAG_VALUE_BYTES) {
      log.warning(`dropping tag '${key}': its value exceeds ${MAX_TAG_VALUE_BYTES} bytes`);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Merges built-ins over custom tags and encodes the result as the header value: unpadded
 * base64url of a JSON object, **keys sorted**. Returns null when there is nothing to send
 * (an absent header means no tags: only default states serve).
 *
 * Deterministic on purpose, and the reason is M3, not tidiness: the ETag design makes a
 * byte-identical request cheap, and `JSON.stringify` serialises a plain object in insertion
 * order — a different header, and a different cache identity, per construction order for the
 * same tags. So the document is assembled from sorted entries explicitly, and the bytes go
 * through TextEncoder before base64 (`btoa` on raw text throws on non-Latin-1 — an emoji in
 * a tag value must encode, not trap).
 *
 * Over the count or document caps, CUSTOM tags are shed from the end of the sorted order
 * until it fits, each drop logged by key. Built-ins always survive: they are small, bounded,
 * and the ones rules most depend on.
 */
export function encodeTags(
  builtin: Readonly<Record<string, string>>,
  custom: Readonly<Record<string, string>>,
  log: Log,
): string | null {
  const kept = new Map<string, string>(
    Object.entries(custom).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

  const overCount = Object.keys(builtin).length + kept.size - MAX_TAG_COUNT;
  if (overCount > 0) {
    const keys = [...kept.keys()];
    for (const key of keys.slice(keys.length - overCount)) {
      log.warning(`dropping tag '${key}': more than ${MAX_TAG_COUNT} tags`);
      kept.delete(key);
    }
  }

  for (;;) {
    const merged = new Map<string, string>(kept);
    for (const [key, value] of Object.entries(builtin)) {
      merged.set(key, value); // built-ins win a collision, though sanitize prevents one
    }
    if (merged.size === 0) return null;
    const document = serializeSorted(merged);
    if (document.length <= MAX_TAG_DOCUMENT_BYTES) {
      return encodeBase64Url(document);
    }
    const keys = [...kept.keys()];
    const last = keys[keys.length - 1];
    if (last === undefined) {
      log.warning("built-in tags alone exceed the document cap; sending none");
      return null;
    }
    log.warning(
      `dropping tag '${last}': the encoded tag document exceeds ${MAX_TAG_DOCUMENT_BYTES} bytes`,
    );
    kept.delete(last);
  }
}

/**
 * JSON with sorted keys, hand-assembled. Determinism here is a contract requirement, so the
 * serialisation is explicit — escaping delegated to JSON.stringify on each string, which is
 * the platform's own escaper.
 */
function serializeSorted(tags: ReadonlyMap<string, string>): Uint8Array {
  const parts: string[] = [];
  for (const key of [...tags.keys()].sort()) {
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(tags.get(key) ?? "")}`);
  }
  return encoder.encode(`{${parts.join(",")}}`);
}
