// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Releasing a hold outside the global region is a call to the global region
 * (inner#1955). One that finds the global region unavailable is queued and
 * retried, so the Studio's credits are not held until the hold expires.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as coreModule from "@breatic/core";

const queueAdd = vi.hoisted(() => vi.fn(async () => undefined));
const releaseHold = vi.hoisted(() => vi.fn());
const abandonHold = vi.hoisted(() => vi.fn());
const where = vi.hoisted(() => ({ region: "sg" }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof coreModule>();
  return {
    ...actual,
    isGlobalRegion: () => where.region === "us-west",
    env: { PAYMENT_ENABLED: true },
    createQueue: () => ({ add: queueAdd }),
    getRegionsConfig: () => ({ hold_cleanup_retry_attempts: 12, hold_cleanup_retry_base_ms: 5000 }),
  };
});
vi.mock("@domain/region/global-api.js", () => ({ globalApi: () => ({ releaseHold, abandonHold }) }));

import { GlobalApiError } from "@breatic/core";
import {
  abandonHold as abandonHere,
  CREDIT_HOLD_RELEASE_QUEUE,
  releaseHold as releaseHere,
  runQueuedHoldRelease,
} from "@domain/credit/creditHold.service.js";

/** The retry the queued cleanup must carry: twelve tries from a 5 s wait, doubling, about 5.7 h in all. */
const RETRY = { attempts: 12, backoff: { type: "exponential", delay: 5000 }, removeOnFail: true };

beforeEach(() => {
  queueAdd.mockClear();
  releaseHold.mockReset();
  abandonHold.mockReset();
  where.region = "sg";
});

describe("releasing a hold outside the global region", () => {
  it("queues the release for retry when the global region is unavailable", async () => {
    releaseHold.mockRejectedValue(new GlobalApiError(503, "unavailable", "down"));

    await releaseHere("task-1");

    expect(queueAdd).toHaveBeenCalledWith("release", { referenceId: "task-1" }, expect.objectContaining({ jobId: "task-1", ...RETRY }));
    expect(CREDIT_HOLD_RELEASE_QUEUE).toBe("credit-hold-release");
  });

  it("queues nothing when the release went through", async () => {
    releaseHold.mockResolvedValue(undefined);

    await releaseHere("task-2");

    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("throws a refusal that is not an outage, queuing nothing", async () => {
    releaseHold.mockRejectedValue(new GlobalApiError(400, "bad_request", "no"));

    await expect(releaseHere("task-3")).rejects.toThrow();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("throws in the global region, where the release is a local write", async () => {
    where.region = "us-west";
    releaseHold.mockRejectedValue(new GlobalApiError(503, "unavailable", "down"));

    await expect(releaseHere("task-4")).rejects.toThrow();
    expect(queueAdd).not.toHaveBeenCalled();
  });
});

describe("giving up a hold outside the global region", () => {
  it("queues the abandon with the same retry when the global region is unavailable", async () => {
    abandonHold.mockRejectedValue(new GlobalApiError(503, "unavailable", "down"));

    await abandonHere({ studioId: "s-1", actorUserId: "u-1", referenceId: "task-5" });

    expect(queueAdd).toHaveBeenCalledWith(
      "release",
      { referenceId: "task-5", abandon: { studioId: "s-1", actorUserId: "u-1" } },
      expect.objectContaining({ jobId: "task-5", ...RETRY }),
    );
  });

  it("throws a refusal that is not an outage, queuing nothing", async () => {
    abandonHold.mockRejectedValue(new GlobalApiError(400, "bad_request", "no"));

    await expect(abandonHere({ studioId: "s-1", actorUserId: "u-1", referenceId: "task-6" })).rejects.toThrow();
    expect(queueAdd).not.toHaveBeenCalled();
  });
});

describe("running a queued cleanup", () => {
  it("releases a queued release and abandons a queued abandon", async () => {
    releaseHold.mockResolvedValue(undefined);
    abandonHold.mockResolvedValue(undefined);

    await runQueuedHoldRelease({ referenceId: "task-7" });
    await runQueuedHoldRelease({ referenceId: "task-8", abandon: { studioId: "s-1", actorUserId: "u-1" } });

    expect(releaseHold).toHaveBeenCalledWith("task-7");
    expect(abandonHold).toHaveBeenCalledWith({ studioId: "s-1", actorUserId: "u-1", referenceId: "task-8" });
  });
});
