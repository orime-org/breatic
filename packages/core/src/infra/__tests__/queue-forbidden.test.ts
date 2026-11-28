// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A process that called `forbidQueues()` cannot open any BullMQ queue, queue
 * events listener or worker through core's factories, and every refused attempt
 * is counted so a caller that swallows the error is still seen (inner#2043).
 */

import { describe, expect, it, vi } from "vitest";

const { built } = vi.hoisted(() => ({ built: [] as string[] }));
vi.mock("@core/config/env.js", () => ({
  env: { REDIS_QUEUE_URL: "redis://localhost:6379/1" },
  MONOREPO_ROOT: decodeURIComponent(new URL("../../../../../", import.meta.url).pathname),
}));
vi.mock("bullmq", () => {
  class Spy {
    constructor(name: string) {
      built.push(name);
    }
    async close(): Promise<void> {}
  }
  return { Queue: Spy, QueueEvents: Spy, Worker: Spy };
});

import { createQueue, createQueueEvents, createWorker, forbidQueues, forbiddenQueueAttempts } from "../queue.js";
import { QueuesForbiddenError } from "../errors.js";

describe("forbidQueues", () => {
  it("lets queues open before it is called", () => {
    createQueue("before");
    expect(built).toEqual(["before"]);
    expect(forbiddenQueueAttempts()).toBe(0);
  });

  it("refuses every factory afterwards, builds nothing and counts each refusal", () => {
    built.length = 0;
    forbidQueues();
    expect(() => createQueue("jobs")).toThrow(QueuesForbiddenError);
    expect(() => createQueueEvents("jobs")).toThrow(QueuesForbiddenError);
    expect(() => createWorker("jobs", async () => undefined)).toThrow(QueuesForbiddenError);
    expect(built).toEqual([]);
    expect(forbiddenQueueAttempts()).toBe(3);
  });

  it("still counts a refusal the caller caught and ignored", () => {
    const before = forbiddenQueueAttempts();
    try {
      createQueue("swallowed");
    } catch {
      // The caller under test swallows it; the count must still move.
    }
    expect(forbiddenQueueAttempts()).toBe(before + 1);
  });
});
