// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from "vitest";

import type * as Core from "@breatic/core";
import { type GroupConsumerOptions, type GroupConsumerReport } from "@breatic/core";

import { retryDelayMs, startGroupConsumer } from "@collab/services/stream-group-consumer.js";

describe("retryDelayMs", () => {
  it("waits the minimum after the first failure and doubles after each next one", () => {
    expect(retryDelayMs(1, 10_000, 600_000)).toBe(10_000);
    expect(retryDelayMs(2, 10_000, 600_000)).toBe(20_000);
    expect(retryDelayMs(3, 10_000, 600_000)).toBe(40_000);
  });

  it("never waits longer than the maximum", () => {
    expect(retryDelayMs(10, 10_000, 600_000)).toBe(600_000);
    expect(retryDelayMs(500, 10_000, 600_000)).toBe(600_000);
  });
});

const mocks = vi.hoisted(() => ({
  start: vi.fn((_options: GroupConsumerOptions) => ({ stop: vi.fn() })),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof Core>()),
  startGroupConsumer: mocks.start,
  createLogger: () => mocks.logger,
}));

const context = { streamKey: "events", group: "workers", err: new Error("failed") };
const reports: Array<{ level: "info" | "warn" | "error"; report: GroupConsumerReport }> = [
  { level: "info", report: { event: "stream_group_created", context: { ...context, start: "0" } } },
  { level: "info", report: { event: "stream_group_consumer_forgotten", context: { ...context, consumer: "old" } } },
  { level: "info", report: { event: "stream_entries_handed_over", context: { ...context, count: 2 } } },
  { level: "warn", report: { event: "stream_entries_trimmed_before_handled", context: { ...context, ids: ["1-0"] } } },
  { level: "warn", report: { event: "stream_entry_failed_will_retry", context: { ...context, id: "1-0", failures: 1, delayMs: 20 } } },
  { level: "warn", report: { event: "stream_entries_renew_failed", context } },
  { level: "error", report: { event: "stream_entry_dead_lettered", context: { ...context, deadKey: "dead", id: "1-0", originId: "1-0", failures: 3, payload: "data" } } },
  { level: "error", report: { event: "stream_entry_failure_not_recorded", context: { ...context, id: "1-0" } } },
  { level: "error", report: { event: "stream_round_settle_failed", context: { ...context, ids: ["1-0"] } } },
  { level: "error", report: { event: "stream_group_create_failed", context } },
  { level: "error", report: { event: "stream_group_loop_failed", context } },
  { level: "error", report: { event: "stream_hand_over_failed", context } },
];

describe("collab consumer reporting", () => {
  it.each(reports)("preserves the $level mapping for $report.event", ({ level, report }) => {
    vi.clearAllMocks();
    startGroupConsumer({ streamKey: "events" } as GroupConsumerOptions);
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({
      streamKey: "events", connectionNamePrefix: "collab-group", report: expect.any(Function),
    }));
    const options = mocks.start.mock.calls[0]![0];
    options.report(report);
    expect(mocks.logger[level]).toHaveBeenCalledExactlyOnceWith(report.context, report.event);
    for (const other of ["info", "warn", "error"] as const) {
      if (other !== level) expect(mocks.logger[other]).not.toHaveBeenCalled();
    }
  });
});
