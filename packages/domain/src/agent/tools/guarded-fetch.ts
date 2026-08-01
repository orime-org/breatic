// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The seam between the shared HTTP transport and the SSRF guard.
 *
 * It lives in its own file because it is its own concern: the transport wants
 * a `typeof fetch`, the guard beneath offers a narrower contract, and this is
 * where the two are reconciled. Keeping it beside the tool that happens to use
 * it first also made it untestable — importing that tool pulls in the whole
 * agent dependency chain.
 */

import { safeFetch } from "@domain/agent/tools/safe-fetch.js";

/**
 * A request shape this seam cannot carry, refused rather than degraded.
 *
 * A distinct type because the transport skips its retries only for errors the
 * caller identifies as deterministic. A plain `Error` here was replayed three
 * times against the same wall — the refusal is the same on every attempt, so
 * the budget bought nothing.
 */
export class UnsupportedRequestError extends Error {
  /**
   * Build the refusal.
   * @param detail - What was asked for that this seam cannot carry.
   */
  constructor(detail: string) {
    super(`the SSRF guard cannot carry this request: ${detail}`);
    this.name = "UnsupportedRequestError";
  }
}

/**
 * Read the headers off a `RequestInit`, refusing shapes this seam drops.
 *
 * `RequestInit.headers` legally takes three forms — a plain record, a
 * `Headers` instance, and an array of pairs — and `SafeFetchOptions` accepts
 * only the first. Casting the other two to a record does not convert them; it
 * produces an object with no own enumerable keys, so the headers vanish and
 * the request goes out bare. An `Authorization` disappearing quietly is worse
 * than a request that refuses to be sent.
 * @param headers - Whatever the caller put on `init.headers`.
 * @returns The record, or undefined when none was given.
 * @throws {UnsupportedRequestError} For a shape that would be silently lost.
 */
function plainHeaders(headers: HeadersInit | undefined): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  if (headers instanceof Headers) {
    throw new UnsupportedRequestError("headers were given as a Headers instance");
  }
  if (Array.isArray(headers)) {
    throw new UnsupportedRequestError("headers were given as an array of pairs");
  }
  return headers;
}

/**
 * Present {@link safeFetch} with the standard fetch signature so the shared
 * transport can drive it.
 *
 * Retrying ABOVE the guard rather than inside a connection pool is the whole
 * reason for this shape: every replay re-runs the per-hop DNS resolution and
 * range check, so a rebinding answer on a later attempt is still caught. A
 * pool-level retry would reconnect beneath the check and see none of it.
 *
 * The `typeof fetch` signature is wider than what `safeFetch` can honour:
 * `SafeFetchOptions` carries headers, a per-hop deadline and a signal, and
 * nothing else — it is a GET-shaped guard. Anything else is refused rather
 * than dropped. Silently discarding a `method` would turn a future POST tool
 * into a GET that looks like it worked, and a request that quietly becomes a
 * different request is the worst way for this to fail.
 * @param input - Request URL, as handed over by the transport.
 * @param init - Headers plus the transport's per-attempt signal.
 * @returns The guarded response.
 * @throws {UnsupportedRequestError} When asked for anything this seam cannot carry.
 */
export const guardedFetch: typeof fetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ?? null;
  if (method !== "GET" || body !== null) {
    throw new UnsupportedRequestError(
      `asked for ${method}${body !== null ? " with a body" : ""}, and only GET is carried`,
    );
  }
  return safeFetch(typeof input === "string" ? input : String(input), {
    headers: plainHeaders(init?.headers),
    signal: init?.signal ?? undefined,
  });
};
