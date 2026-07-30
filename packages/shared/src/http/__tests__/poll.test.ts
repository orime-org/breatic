// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * `pollUntilDone` drives every asynchronous AIGC task: submit returns a
 * vendor task id, and this loop asks "done yet?" until the vendor reports a
 * terminal status or the budget runs out.
 *
 * It had no tests of its own before this file. The 13 transport `*-resume`
 * suites all mock it away, so its three exits — success, vendor-reported
 * failure, and timeout — were never exercised, on a path that decides
 * whether a paid generation is collected or abandoned.
 *
 * Two behaviours here are corrections rather than ports:
 *
 *   - Each poll request gets its own timeout. The previous implementation
 *     passed no signal at all, so a vendor that accepted the connection and
 *     then went quiet could hang a single request indefinitely while the
 *     "5 minute" budget never advanced.
 *   - The budget is measured on the clock. The previous implementation
 *     summed only the sleep intervals, so with 10-second responses and a
 *     3-second interval a nominal 5-minute wait ran past 20 minutes.
 */

import { describe, it, expect, vi } from "vitest";

import { pollUntilDone } from "@shared/http/poll.js";
import type { PollEvent } from "@shared/http/poll.js";
import type { HttpRetryEvent } from "@shared/http/request.js";

/** A JSON response carrying the given body. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that plays back one outcome per call, then repeats the last. */
function playback(
  outcomes: Array<Response | (() => Promise<Response>)>,
): { fetchImpl: typeof fetch; urls: string[]; calls: () => number } {
  const urls: string[] = [];
  let call = 0;
  const fetchImpl = ((url: string): Promise<Response> => {
    urls.push(String(url));
    const outcome = outcomes[Math.min(call, outcomes.length - 1)];
    call += 1;
    if (outcome === undefined) {
      return Promise.reject(new Error("probe: playback list is empty"));
    }
    if (typeof outcome === "function") return outcome();
    // Fresh clone per call: a Response body may only be read once.
    return Promise.resolve(outcome.clone());
  }) as unknown as typeof fetch;
  return { fetchImpl, urls, calls: (): number => call };
}

/** Baseline poll options; each test varies one thing. */
function opts(over: Partial<Parameters<typeof pollUntilDone>[1]> = {}): Parameters<typeof pollUntilDone>[1] {
  return {
    statusPath: ["data", "status"],
    successStatuses: new Set(["completed"]),
    failureStatuses: new Set(["failed"]),
    intervalMs: 10,
    maxWaitMs: 2000,
    timeoutMs: 500,
    label: "wavespeed",
    ...over,
  };
}

describe("pollUntilDone — terminal statuses", () => {
  it("returns the response as soon as a success status appears", async () => {
    const { fetchImpl, calls } = playback([
      json({ data: { status: "processing" } }),
      json({ data: { status: "completed", output: "https://cdn/x.png" } }),
    ]);
    const out = await pollUntilDone("https://v.test/task/1", opts({ fetchImpl }));
    expect(calls()).toBe(2);
    expect(out).toMatchObject({ data: { status: "completed", output: "https://cdn/x.png" } });
  });

  it("rejects with the vendor's message on a failure status", async () => {
    const { fetchImpl } = playback([
      json({ data: { status: "failed" }, error: { message: "content policy" } }),
    ]);
    await expect(
      pollUntilDone(
        "https://v.test/task/2",
        opts({ fetchImpl, errorPath: ["error", "message"] }),
      ),
    ).rejects.toThrow(/wavespeed.*content policy/s);
  });

  it("rejects with 'unknown' when no error path was declared", async () => {
    const { fetchImpl } = playback([json({ data: { status: "failed" } })]);
    await expect(
      pollUntilDone("https://v.test/task/3", opts({ fetchImpl })),
    ).rejects.toThrow(/unknown/);
  });

  it("keeps polling through statuses that are neither terminal", async () => {
    const { fetchImpl, calls } = playback([
      json({ data: { status: "queued" } }),
      json({ data: { status: "starting" } }),
      json({ data: { status: "processing" } }),
      json({ data: { status: "completed" } }),
    ]);
    await pollUntilDone("https://v.test/task/4", opts({ fetchImpl }));
    expect(calls()).toBe(4);
  });

  it("treats an absent status field as non-terminal rather than crashing", async () => {
    const { fetchImpl, calls } = playback([
      json({ unexpected: true }),
      json({ data: { status: "completed" } }),
    ]);
    await pollUntilDone("https://v.test/task/5", opts({ fetchImpl }));
    expect(calls()).toBe(2);
  });
});

describe("pollUntilDone — budget", () => {
  it("rejects once the wall-clock budget is spent", async () => {
    const { fetchImpl } = playback([json({ data: { status: "processing" } })]);
    await expect(
      pollUntilDone(
        "https://v.test/task/6",
        opts({ fetchImpl, intervalMs: 10, maxWaitMs: 80 }),
      ),
    ).rejects.toThrow(/did not complete/);
  });

  it("counts request time against the budget, not just the sleeps", async () => {
    // The corrected behaviour. A slow vendor used to extend the deadline
    // for free: summing only intervals meant a 60 ms budget with 10 ms
    // sleeps allowed six requests no matter how long each one took.
    const slow = async (): Promise<Response> => {
      await new Promise((r) => setTimeout(r, 40));
      return json({ data: { status: "processing" } });
    };
    const { fetchImpl, calls } = playback([slow]);
    await expect(
      pollUntilDone(
        "https://v.test/task/7",
        opts({ fetchImpl, intervalMs: 5, maxWaitMs: 100 }),
      ),
    ).rejects.toThrow(/did not complete/);
    // ~45 ms per cycle against a 100 ms budget: a handful of attempts, not
    // the twenty that interval-only accounting would have permitted.
    expect(calls()).toBeLessThanOrEqual(4);
  });

  it("reports the budget in seconds in the timeout message", async () => {
    const { fetchImpl } = playback([json({ data: { status: "processing" } })]);
    await expect(
      pollUntilDone("https://v.test/task/8", opts({ fetchImpl, maxWaitMs: 2000, intervalMs: 10 })),
    ).rejects.toThrow(/2s/);
  });
});

describe("pollUntilDone — request shape", () => {
  it("appends query params to the poll URL", async () => {
    const { fetchImpl, urls } = playback([json({ data: { status: "completed" } })]);
    await pollUntilDone(
      "https://v.test/query",
      opts({ fetchImpl, params: { task_id: "abc-123", region: "us" } }),
    );
    expect(urls[0]).toContain("task_id=abc-123");
    expect(urls[0]).toContain("region=us");
  });

  it("sends the caller's headers on every poll", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fetchImpl = ((_u: string, init?: RequestInit): Promise<Response> => {
      seen.push({ ...(init?.headers as Record<string, unknown>) });
      return Promise.resolve(json({ data: { status: seen.length < 2 ? "processing" : "completed" } }));
    }) as unknown as typeof fetch;
    await pollUntilDone(
      "https://v.test/hdr",
      opts({ fetchImpl, headers: { Authorization: "Bearer k" } }),
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ Authorization: "Bearer k" });
    expect(seen[1]).toMatchObject({ Authorization: "Bearer k" });
  });

  it("gives every poll request its own deadline (hole ③ regression)", async () => {
    // A vendor that accepts the connection and never answers must not hang
    // the loop: the attempt aborts, the transport retries it, and the
    // budget keeps ticking.
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchImpl = ((_u: string, init?: RequestInit): Promise<Response> => {
      signals.push(init?.signal);
      return Promise.resolve(json({ data: { status: "completed" } }));
    }) as unknown as typeof fetch;
    await pollUntilDone("https://v.test/deadline", opts({ fetchImpl }));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
  });
});

describe("pollUntilDone — telemetry", () => {
  it("reports a vendor-reported failure", async () => {
    const events: Array<PollEvent | HttpRetryEvent> = [];
    const { fetchImpl } = playback([
      json({ data: { status: "failed" }, error: { message: "nsfw" } }),
    ]);
    await expect(
      pollUntilDone(
        "https://v.test/task/9",
        opts({ fetchImpl, errorPath: ["error", "message"], onEvent: (e) => events.push(e) }),
      ),
    ).rejects.toThrow();
    expect(events).toContainEqual(
      expect.objectContaining({ type: "poll_failed", status: "failed", error: "nsfw" }),
    );
  });

  it("reports a budget timeout", async () => {
    const events: Array<PollEvent | HttpRetryEvent> = [];
    const { fetchImpl } = playback([json({ data: { status: "processing" } })]);
    await expect(
      pollUntilDone(
        "https://v.test/task/10",
        opts({ fetchImpl, intervalMs: 10, maxWaitMs: 60, onEvent: (e) => events.push(e) }),
      ),
    ).rejects.toThrow();
    expect(events).toContainEqual(
      expect.objectContaining({ type: "poll_timeout", maxWaitMs: 60 }),
    );
  });

  it("forwards the transport's own retry events", async () => {
    // A 503 on a poll is retried by the transport beneath; the application
    // layer should still see it, so a flaky vendor is visible in the logs.
    const events: Array<PollEvent | HttpRetryEvent> = [];
    let call = 0;
    const fetchImpl = ((): Promise<Response> => {
      call += 1;
      return Promise.resolve(
        call === 1 ? json({}, 503) : json({ data: { status: "completed" } }),
      );
    }) as unknown as typeof fetch;
    await pollUntilDone("https://v.test/flaky", opts({ fetchImpl, onEvent: (e) => events.push(e) }));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "retry", reason: "server_error", status: 503 }),
    );
  });
});

describe("pollUntilDone — cancellation", () => {
  it("rejects with the caller's reason, not a budget timeout", async () => {
    // The assertion is on WHICH failure surfaces. An earlier version of
    // this test used a stub that ignored the abort signal, so the loop ran
    // to the end of its budget and the timeout error made the test pass for
    // the wrong reason — hiding that cancellation was not honoured at all.
    // Matching the caller's own message is what pins it down.
    const ac = new AbortController();
    const spy = vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.signal?.aborted === true) {
        throw new DOMException("aborted", "AbortError");
      }
      return json({ data: { status: "processing" } });
    });
    setTimeout(() => ac.abort(new Error("user pressed stop")), 30);
    const started = Date.now();
    await expect(
      pollUntilDone(
        "https://v.test/cancel",
        opts({
          fetchImpl: spy as unknown as typeof fetch,
          signal: ac.signal,
          intervalMs: 5,
          maxWaitMs: 5000,
        }),
      ),
    ).rejects.toThrow(/user pressed stop/);
    // And it stopped promptly rather than burning the 5 s budget.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("spends no further vendor request once cancelled mid-interval", async () => {
    // A poll can be a billed call, so waking from the sleep must not fire
    // one more request for a task nobody is waiting for.
    const ac = new AbortController();
    const spy = vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.signal?.aborted === true) {
        throw new DOMException("aborted", "AbortError");
      }
      // Cancel while the loop is sleeping, not while a request is in flight.
      setTimeout(() => ac.abort(new Error("stop")), 1);
      return json({ data: { status: "processing" } });
    });
    await expect(
      pollUntilDone(
        "https://v.test/mid-interval",
        opts({
          fetchImpl: spy as unknown as typeof fetch,
          signal: ac.signal,
          intervalMs: 30,
          maxWaitMs: 5000,
        }),
      ),
    ).rejects.toThrow(/stop/);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
