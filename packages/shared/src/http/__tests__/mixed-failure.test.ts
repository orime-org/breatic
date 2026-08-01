// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * When attempts fail in DIFFERENT ways, the outcome must belong to the last
 * one.
 *
 * The transport tracked "last response" and "last error" independently and
 * preferred the response, so a non-ok reply from attempt 1 outlived its own
 * attempt and was handed back as the outcome of a later failure that
 * produced no response at all. Every pre-existing test drove homogeneous
 * failures — all responses, or all throws — which is the one shape where the
 * two variables cannot disagree, so a green suite proved nothing here.
 *
 * The consequences were not cosmetic. `web_fetch` classifies an SSRF refusal
 * through `isFatal` and reports it by catching that error; with the earlier
 * response winning, the tool answered `HTTP 503` instead and the refusal left
 * no trace at all, because that call site passes no telemetry sink.
 */

import { describe, it, expect } from "vitest";

import { httpRequest } from "@shared/http/request.js";

const URL_UNDER_TEST = "https://vendor.test/v1/predictions";

/** A distinct error type, standing in for the SSRF guard's refusal. */
class BlockedAddressError extends Error {}

/** A JSON response with the given status. */
function res(status: number, body: unknown = { vendor: "overloaded" }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that plays back the given outcomes, one per call. */
function scriptedFetch(outcomes: ReadonlyArray<Response | Error>): typeof fetch {
  let call = 0;
  return ((): Promise<Response> => {
    const outcome = outcomes[call] ?? new Error(`probe: no outcome #${call}`);
    call += 1;
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  }) as unknown as typeof fetch;
}

/** Baseline options: replay-safe, deadlines short enough to keep tests quick. */
function opts(fetchImpl: typeof fetch): Parameters<typeof httpRequest>[2] {
  return {
    replaySafe: true,
    timeoutMs: 1_000,
    bodyIdleTimeoutMs: 200,
    fetchImpl,
    label: "probe",
  };
}

describe("an outcome belongs to the attempt that produced it", () => {
  it("reports the dropped connection, not the 503 that preceded it", async () => {
    const fetchImpl = scriptedFetch([
      res(503),
      new Error("ECONNRESET"),
      new Error("ECONNRESET"),
    ]);

    // The real failure is the dropped connection. Returning the stale 503
    // would tell on-call the vendor rejected us when the network broke.
    await expect(httpRequest(URL_UNDER_TEST, {}, opts(fetchImpl))).rejects.toThrow(
      /ECONNRESET/,
    );
  });

  it("surfaces a fatal refusal that follows a retryable status", async () => {
    const fetchImpl = scriptedFetch([res(503), new BlockedAddressError("blocked: 10.0.0.1")]);

    // This is the SSRF shape: a page 503s, the replay redirects to a private
    // address, and the guard refuses. The refusal must reach the caller — it
    // is the only thing that distinguishes "site was down" from "someone
    // pointed us at the internal network".
    await expect(
      httpRequest(URL_UNDER_TEST, {}, {
        ...opts(fetchImpl),
        isFatal: (err) => err instanceof BlockedAddressError,
      }),
    ).rejects.toThrow(BlockedAddressError);
  });

  it("still returns the response when the LAST attempt produced one", async () => {
    // The mirror image, so the fix cannot be "always throw": here the final
    // attempt really did answer, and its answer is the outcome.
    const fetchImpl = scriptedFetch([new Error("ECONNRESET"), res(404, { detail: "gone" })]);

    const out = await httpRequest(URL_UNDER_TEST, {}, opts(fetchImpl));

    expect(out.status).toBe(404);
  });
});

describe("cancellation during a backoff wait", () => {
  it("rejects with the caller's reason instead of waiting the delay out", async () => {
    // Retry-After of 8s. Nothing clamps it — the ceiling decides whether to
    // wait at all, and this caller declares nothing, so the sixty-second
    // background ceiling applies and eight seconds is served in full. Long
    // enough that waiting it out would be unmistakable in the elapsed time.
    //
    // The comment here used to say "clamped to the transport's 10s ceiling",
    // which described a mechanism that no longer exists and named the wrong
    // ceiling for its own caller besides.
    const rateLimited = new Response("{}", {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "8" },
    });
    const controller = new AbortController();
    const fetchImpl = scriptedFetch([rateLimited, res(200, { ok: true })]);

    const started = Date.now();
    const inFlight = httpRequest(URL_UNDER_TEST, {}, {
      ...opts(fetchImpl),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("user pressed stop")), 50);

    await expect(inFlight).rejects.toThrow(/user pressed stop/);
    // Must not have served out the backoff before noticing.
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
