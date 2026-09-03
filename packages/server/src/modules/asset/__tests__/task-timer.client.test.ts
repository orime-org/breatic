// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Arming the timer that will judge one task dead (#186, design §4.6.5).
 *
 * The timer lives in the ingest Worker, so reaching it is one authenticated
 * HTTP call. What matters here is that the caller can tell whether the alarm
 * is set: a task whose deadline nobody holds has no one to judge it, so the
 * endpoint that opens the task refuses to go on when this says no.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@breatic/core", () => ({
  env: {
    INGEST_BASE_URL: "https://ingest.test.example",
    INGEST_SHARED_SECRET: "test-ingest-secret",
  },
}));

const { armTaskTimer } = await import("@server/modules/asset/task-timer.client.js");

const TASK = "55555555-5555-4555-8555-555555555555";
const CALLBACK = "https://api.test.example/api/v1/canvas/node-tasks/expired";

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("arming a task timer", () => {
  it("posts the task, its deadline and where to knock", async () => {
    const deadlineAt = 1_788_000_000_000;

    await armTaskTimer({ taskId: TASK, deadlineAt, callbackUrl: CALLBACK });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ingest.test.example/task-timers/arm");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      taskId: TASK,
      deadlineAt,
      callbackUrl: CALLBACK,
    });
  });

  it("proves who is calling with the shared secret", async () => {
    await armTaskTimer({ taskId: TASK, deadlineAt: 1, callbackUrl: CALLBACK });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-ingest-secret"]).toBe("test-ingest-secret");
  });

  it("reports success when the Worker took it", async () => {
    await expect(
      armTaskTimer({ taskId: TASK, deadlineAt: 1, callbackUrl: CALLBACK }),
    ).resolves.toBe(true);
  });

  it("reports failure when the Worker refused", async () => {
    fetchSpy.mockResolvedValue(new Response("nope", { status: 500 }));

    await expect(
      armTaskTimer({ taskId: TASK, deadlineAt: 1, callbackUrl: CALLBACK }),
    ).resolves.toBe(false);
  });

  it("reports failure when the call never landed", async () => {
    fetchSpy.mockRejectedValue(new Error("connection refused"));

    await expect(
      armTaskTimer({ taskId: TASK, deadlineAt: 1, callbackUrl: CALLBACK }),
    ).resolves.toBe(false);
  });

  it("gives up rather than hanging on a Worker that never answers", async () => {
    // The browser is waiting on the ticket this call gates. A Worker that
    // holds the connection open would hold the upload open with it.
    fetchSpy.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });

    const armed = armTaskTimer({
      taskId: TASK,
      deadlineAt: 1,
      callbackUrl: CALLBACK,
      timeoutMs: 10,
    });

    await expect(armed).resolves.toBe(false);
  });

  it("says no when the Worker is not configured", async () => {
    // Nothing to call. Saying yes here would open a task nothing judges.
    vi.resetModules();
    vi.doMock("@breatic/core", () => ({
      env: { INGEST_BASE_URL: "", INGEST_SHARED_SECRET: "" },
    }));
    const mod = await import("@server/modules/asset/task-timer.client.js");

    await expect(
      mod.armTaskTimer({ taskId: TASK, deadlineAt: 1, callbackUrl: CALLBACK }),
    ).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the ceiling on the whole call", () => {
  it("stops retrying once the caller's own deadline passes", async () => {
    // The transport retries a failed delivery, and its per-delivery deadline
    // bounds each one rather than the loop. A browser is holding a file it
    // cannot start sending, so the loop has a ceiling of its own.
    fetchSpy.mockResolvedValue(new Response("busy", { status: 503 }));

    const started = Date.now();
    await expect(
      armTaskTimer({
        taskId: TASK,
        deadlineAt: 1,
        callbackUrl: CALLBACK,
        timeoutMs: 50,
        overallTimeoutMs: 60,
      }),
    ).resolves.toBe(false);

    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
