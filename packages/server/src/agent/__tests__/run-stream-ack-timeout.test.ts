// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { createResumableStreamContext } from "resumable-stream/generic";
import type { Publisher, Subscriber } from "resumable-stream/generic";

/**
 * A publisher whose stream sentinel always reads "still running", and no producer ever answers.
 * @param get - What reading a key does.
 * @returns The publisher.
 */
function orphanPublisher(get: Publisher["get"] = () => Promise.resolve("1")): Publisher {
  return {
    connect: () => Promise.resolve(),
    publish: () => Promise.resolve(0),
    set: () => Promise.resolve("OK"),
    get,
    incr: () => Promise.resolve(1),
  };
}

const silentSubscriber: Subscriber = {
  connect: () => Promise.resolve(),
  subscribe: () => Promise.resolve(),
  unsubscribe: () => Promise.resolve(),
};

describe("resuming a stream whose producer is gone (patched resumable-stream 2.2.13, vercel/resumable-stream#50)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects once the ack wait is over, even when the timer fires on the exact millisecond", async () => {
    // A 1000 ms timer often fires with Date.now() exactly 1000 ms later; a frozen clock makes that case certain.
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const streams = createResumableStreamContext({ keyPrefix: "t", waitUntil: null, publisher: orphanPublisher(), subscriber: silentSubscriber });
    await expect(streams.resumeExistingStream("R-dead")).rejects.toThrow("Timeout waiting for ack");
  }, 5000);

  it("rejects when reading the sentinel fails after the ack wait", async () => {
    let reads = 0;
    const get: Publisher["get"] = () => (++reads === 1 ? Promise.resolve("1") : Promise.reject(new Error("redis down")));
    const streams = createResumableStreamContext({ keyPrefix: "t", waitUntil: null, publisher: orphanPublisher(get), subscriber: silentSubscriber });
    await expect(streams.resumeExistingStream("R-dead")).rejects.toThrow();
  }, 5000);
});
