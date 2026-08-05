// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The wait between attempts, and the one thing it exists to do beyond
 * `setTimeout`: end early when the caller stops caring.
 *
 * Its cancellation had zero coverage. Every test in the transport injects its
 * own `sleepImpl` — deliberately, so suites do not sit through real backoff —
 * so the real implementation was never once driven by anything, on the path
 * where a person pressing stop has to be felt within a second rather than at
 * the end of a two-second wait.
 */

import { getEventListeners } from "node:events";

import { describe, it, expect } from "vitest";

import { sleep } from "@shared/sleep.js";

describe("sleep", () => {
  it("resolves after the delay", async () => {
    const startedAt = performance.now();
    await sleep(30);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(25);
  });

  it("rejects at once when the signal is already aborted", async () => {
    // The window this covers is real: the transport decides to wait, and the
    // person presses stop between that decision and this call.
    const controller = new AbortController();
    controller.abort(new Error("user pressed stop"));

    const startedAt = performance.now();
    await expect(sleep(5_000, controller.signal)).rejects.toThrow("user pressed stop");
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  it("ends early when the signal aborts mid-wait", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("user pressed stop")), 20);

    const startedAt = performance.now();
    await expect(sleep(5_000, controller.signal)).rejects.toThrow("user pressed stop");
    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeLessThan(500);
  });

  it("carries the caller's own error, not a generic abort", async () => {
    // The whole point of `abort(reason)` is that the reason survives. A caller
    // that says why it stopped must not be handed back "AbortError" instead.
    class StopRequested extends Error {}
    const controller = new AbortController();
    const reason = new StopRequested("the job was cancelled");
    controller.abort(reason);

    await expect(sleep(1_000, controller.signal)).rejects.toBe(reason);
  });

  it("describes a cancellation whose reason is not an Error", async () => {
    // `abort()` takes any value. A string reason must still arrive as
    // something throwable rather than as a rejected non-Error.
    const controller = new AbortController();
    controller.abort("just because");

    await expect(sleep(1_000, controller.signal)).rejects.toThrow(/cancelled/i);
  });

  it("lets go of the signal once it has finished waiting", async () => {
    // A listener left behind pins this closure to a signal that may live for
    // the whole session — and the transport calls this on every replay.
    const controller = new AbortController();
    await sleep(10, controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("lets go of the signal after being cancelled too", async () => {
    const controller = new AbortController();
    const waiting = sleep(5_000, controller.signal);
    controller.abort(new Error("stop"));
    await expect(waiting).rejects.toThrow("stop");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("waits normally when given no signal at all", async () => {
    await expect(sleep(10)).resolves.toBeUndefined();
  });
});
