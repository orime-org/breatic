// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The outbox relay loop every outbox shares (inner#1993 §5.2): a pass forwards
 * rows one at a time through the caller's `forwardNext` until the outbox is
 * empty, the batch is used up or a forward fails; the next pass is scheduled
 * only after this one settles; `stop()` ends it. Failures and dead letters are
 * reported to the caller, which logs them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startRelayLoop, type RelayForward, type RelayLoopEvent } from "@core/outbox/relay-loop.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A `forwardNext` that hands out the given results in order, then reports an empty outbox.
 * @param results - What each call returns.
 * @returns The mock.
 */
function forwards(...results: Array<RelayForward | null>): ReturnType<typeof vi.fn<() => Promise<RelayForward | null>>> {
  const queue = [...results];
  return vi.fn(async () => (queue.length > 0 ? queue.shift()! : null));
}

describe("startRelayLoop", () => {
  it("forwards rows until the outbox is empty on the first pass, which runs at once", async () => {
    const forwardNext = forwards({ id: "1" }, { id: "2" }, null);
    const report = vi.fn();
    const loop = startRelayLoop({ forwardNext, intervalMs: 1000, batchSize: 10, report });
    await vi.advanceTimersByTimeAsync(0);
    expect(forwardNext).toHaveBeenCalledTimes(3);
    expect(report).not.toHaveBeenCalled();
    loop.stop();
  });

  it("stops a pass at the batch size and continues on the next pass", async () => {
    const forwardNext = vi.fn(async () => ({ id: "x" }));
    const loop = startRelayLoop({ forwardNext, intervalMs: 1000, batchSize: 3, report: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(forwardNext).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(forwardNext).toHaveBeenCalledTimes(6);
    loop.stop();
  });

  it("ends the pass after a failed forward, reports it, and tries again on the next pass", async () => {
    const err = new Error("unavailable");
    const forwardNext = forwards({ id: "7", error: err }, { id: "8" });
    const report = vi.fn<(event: RelayLoopEvent) => void>();
    const loop = startRelayLoop({ forwardNext, intervalMs: 1000, batchSize: 10, report });
    await vi.advanceTimersByTimeAsync(0);
    expect(forwardNext).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({ kind: "forward_failed", id: "7", err });
    await vi.advanceTimersByTimeAsync(1000);
    expect(forwardNext).toHaveBeenCalledTimes(3);
    loop.stop();
  });

  it("reports a row moved to dead letters and keeps forwarding", async () => {
    const err = new Error("unknown event type");
    const forwardNext = forwards({ id: "9", error: err, deadLettered: true }, { id: "10" }, null);
    const report = vi.fn<(event: RelayLoopEvent) => void>();
    const loop = startRelayLoop({ forwardNext, intervalMs: 1000, batchSize: 10, report });
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledWith({ kind: "dead_lettered", id: "9", err });
    expect(forwardNext).toHaveBeenCalledTimes(3);
    loop.stop();
  });

  it("reports a pass that threw and still schedules the next one", async () => {
    const err = new Error("db down");
    const forwardNext = vi.fn<() => Promise<RelayForward | null>>().mockRejectedValueOnce(err).mockResolvedValue(null);
    const report = vi.fn<(event: RelayLoopEvent) => void>();
    const loop = startRelayLoop({ forwardNext, intervalMs: 1000, batchSize: 10, report });
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledWith({ kind: "pass_failed", err });
    await vi.advanceTimersByTimeAsync(1000);
    expect(forwardNext).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it("schedules no pass after stop", async () => {
    const forwardNext = forwards(null);
    const loop = startRelayLoop({ forwardNext, intervalMs: 1000, batchSize: 10, report: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    loop.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(forwardNext).toHaveBeenCalledTimes(1);
  });

  it("starts the next pass only after the slow one settles", async () => {
    let release: () => void = () => {};
    const forwardNext = vi
      .fn<() => Promise<RelayForward | null>>()
      .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(null); }))
      .mockResolvedValue(null);
    const loop = startRelayLoop({ forwardNext, intervalMs: 1000, batchSize: 10, report: vi.fn() });
    await vi.advanceTimersByTimeAsync(5000);
    expect(forwardNext).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(forwardNext).toHaveBeenCalledTimes(2);
    loop.stop();
  });
});
