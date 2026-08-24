// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Giving up on a store that is taking too long (#40).
 *
 * The distinction this exists to preserve: giving up on a write and the write
 * being refused are not the same event, and telling them apart is the
 * difference between an operator reading "the database rejected this" and
 * "we stopped waiting; it may well have landed".
 */

import { describe, it, expect } from "vitest";

import { runWithTimeout } from "@collab/services/with-timeout.js";

describe("runWithTimeout", () => {
  it("reports no timeout when the work finishes first", async () => {
    const result = await runWithTimeout(Promise.resolve(), 1_000);

    expect(result.timedOut).toBe(false);
  });

  it("reports a timeout when the deadline passes first", async () => {
    const result = await runWithTimeout(new Promise<void>(() => {}), 10);

    expect(result.timedOut).toBe(true);
  });

  it("does not reject when the work throws — the caller decides what that means", async () => {
    // The store path treats a throw and a timeout the same way: neither says
    // whether the content landed, and only the counters do. Rejecting here
    // would make every caller wrap this in a try/catch to learn nothing.
    await expect(
      runWithTimeout(Promise.reject(new Error("database is down")), 1_000),
    ).resolves.toEqual({ timedOut: false, error: expect.any(Error) });
  });

  it("hands back the error it swallowed, so the caller can log it", async () => {
    const boom = new Error("database is down");

    const result = await runWithTimeout(Promise.reject(boom), 1_000);

    expect(result.error).toBe(boom);
  });

  it("leaves no timer behind once the work finishes", async () => {
    // A pending timer keeps the event loop alive and, in a single-fork test
    // run, leaks into the next file.
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

    await runWithTimeout(Promise.resolve(), 60_000);

    expect(process.getActiveResourcesInfo().filter((r) => r === "Timeout").length).toBe(before);
  });
});
