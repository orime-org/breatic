// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A revocation in the global region reaches every other region (inner#1955):
 * the job that carries it retries and is cleaned up like every other job,
 * and it is queued even when the local collab signal fails.
 */

import type Redis from "ioredis";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  env: { ENV: "dev", REDIS_KEY_PREFIX: "t", REGION: "us-west", GLOBAL_REGION: "us-west", REGION_API_URLS: { sg: "http://sg.invalid" } },
  add: vi.fn(async () => undefined),
  publish: vi.fn(async () => undefined),
}));

vi.mock("@core/config/env.js", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), env: h.env }));
vi.mock("@core/infra/control-events.js", () => ({ publishSessionsRevoked: h.publish }));
vi.mock("@core/infra/queue.js", () => ({
  createQueue: () => ({ add: h.add }),
  defaultJobOpts: () => ({ attempts: 3, backoff: { type: "jitter" }, removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 86400, count: 1000 } }),
}));

const { revokeSession } = await import("@core/infra/session-store.js");

/**
 * A Redis whose MULTI ends one session of the user.
 * @returns The stand-in.
 */
function redisEnding(): Redis {
  const chain = { get: () => chain, del: () => chain, exec: async () => [[null, "u-1"], [null, 1], [null, 1]] };
  return { multi: () => chain } as unknown as Redis;
}

beforeEach(() => vi.clearAllMocks());

describe("forwarding a revocation to the other regions", () => {
  it("queues the job with the retry and cleanup every job has", async () => {
    await revokeSession(redisEnding(), "token-1");

    expect(h.add).toHaveBeenCalledWith(
      "revoke",
      expect.objectContaining({ region: "sg", userId: "u-1" }),
      expect.objectContaining({ attempts: 3, removeOnComplete: expect.anything(), removeOnFail: expect.anything() }),
    );
  });

  it("still queues it when the local collab signal fails, and reports that failure", async () => {
    const down = new Error("stream redis down");
    h.publish.mockRejectedValueOnce(down);

    const outcome = await revokeSession(redisEnding(), "token-1");

    expect(h.add).toHaveBeenCalledTimes(1);
    expect(outcome.signalFailure).toBe(down);
  });
});
