// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as RedisModule from "@core/infra/redis.js";
import { type Redis } from "ioredis";

import { retryDelayMs, startGroupConsumer, type GroupConsumerOptions } from "@core/infra/stream-group-consumer.js";

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


const redis = vi.hoisted(() => {
  let releaseRead: (() => void) | undefined;
  const reader = {
    xreadgroup: vi.fn(() => new Promise<null>((resolve) => { releaseRead = () => resolve(null); })),
    disconnect: vi.fn(() => releaseRead?.()),
  };
  const commands = {
    get: vi.fn().mockResolvedValue(null),
    xgroup: vi.fn().mockResolvedValue("OK"),
    xautoclaim: vi.fn().mockResolvedValue(["0-0", [], []]),
    xinfo: vi.fn().mockResolvedValue([]),
    xpending: vi.fn().mockResolvedValue([]),
    quit: vi.fn().mockResolvedValue("OK"),
    disconnect: vi.fn(),
  };
  const coordination = { hincrby: vi.fn(), expire: vi.fn(), hdel: vi.fn() };
  return { reader, commands, coordination };
});

vi.mock("@core/infra/redis.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RedisModule>()),
  createRedisClient: vi.fn((_url, options) => options.name.includes("read:") ? redis.reader : redis.commands),
}));

afterEach(() => { vi.clearAllMocks(); });


/**
 * Build an isolated consumer using sockets controlled by the test.
 * @param report - Observe the actual consumer reports.
 * @returns The consumer options.
 */
function consumerOptions(report: GroupConsumerOptions["report"]): GroupConsumerOptions {
  return {
      streamUrl: "redis://unused", streamKey: "events", group: "workers", consumer: "one",
      legacyCursorKey: "cursor", failuresKey: "failures",
      coordination: redis.coordination as unknown as Redis,
      settings: {
        maxHeld: 16, keyConcurrency: 16, blockMs: 100, leaseRetryMs: 20,
        claimIntervalMs: 100, claimIdleMs: 300, retryMinMs: 20, retryMaxMs: 80,
        maxFailures: 3, stopDeadlineMs: 2000, forgetIdleConsumerMs: 86400000,
      },
      keyOf: () => "key", process: async () => new Map(), report,
    };
}

describe("consumer reports", () => {
  it("reports group creation with the cursor actually installed", async () => {
    redis.commands.get.mockResolvedValueOnce("42-0");
    const report = vi.fn();
    const options = consumerOptions(report);
    const consumer = startGroupConsumer(options);
    try {
      await vi.waitFor(() => expect(redis.reader.xreadgroup).toHaveBeenCalled());
      expect(report).toHaveBeenCalledWith({
        event: "stream_group_created", context: { streamKey: "events", group: "workers", start: "42-0" },
      });
    } finally {
      await consumer.stop();
    }
  });

  it("reports the original error when group creation fails", async () => {
    const err = new Error("Redis unavailable");
    redis.commands.xgroup.mockRejectedValueOnce(err);
    const report = vi.fn();
    const consumer = startGroupConsumer(consumerOptions(report));
    try {
      await vi.waitFor(() => expect(report).toHaveBeenCalledWith({
        event: "stream_group_create_failed", context: { err, streamKey: "events", group: "workers" },
      }));
    } finally {
      await consumer.stop();
    }
  });

});
