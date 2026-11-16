// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Releasing or giving up a hold outside the global region is a call to the
 * global region (inner#1955). One that finds the global region unavailable is
 * queued and retried once per interval while the hold lives, so the Studio's
 * credits are freed within one interval of the global region coming back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as coreModule from "@breatic/core";

const queueAdd = vi.hoisted(() => vi.fn(async () => undefined));
const releaseHold = vi.hoisted(() => vi.fn());
const abandonHold = vi.hoisted(() => vi.fn());
const extendHold = vi.hoisted(() => vi.fn());
const where = vi.hoisted(() => ({ region: "sg", payments: true }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof coreModule>();
  return {
    ...actual,
    isGlobalRegion: () => where.region === "us-west",
    env: {
      get PAYMENT_ENABLED() {
        return where.payments;
      },
    },
    createQueue: () => ({ add: queueAdd }),
    getRegionsConfig: () => ({ hold_cleanup_retry_interval_ms: 30_000 }),
    getNodeTaskConfig: () => ({ default_budget_ms: 7_200_000 }),
  };
});
vi.mock("@domain/region/global-api.js", () => ({ globalApi: () => ({ releaseHold, abandonHold, extendHold }) }));

import { GlobalApiError } from "@breatic/core";
import {
  abandonHold as abandonHere,
  CREDIT_HOLD_RELEASE_QUEUE,
  extendHold as extendHere,
  holdCleanupRetry,
  releaseHold as releaseHere,
  runQueuedHoldRelease,
} from "@domain/credit/creditHold.service.js";

/** One try every 30 s for the two hours a hold lives: 240 waits after the first try, keeping one stack trace. */
const RETRY = { attempts: 241, backoff: { type: "fixed", delay: 30_000 }, removeOnFail: true, stackTraceLimit: 1 };

beforeEach(() => {
  queueAdd.mockClear();
  releaseHold.mockReset();
  abandonHold.mockReset();
  extendHold.mockReset();
  where.region = "sg";
  where.payments = true;
});

describe("the retry a queued cleanup carries", () => {
  it("tries once per interval for as long as a hold lives", () => {
    const { attempts, backoff } = holdCleanupRetry();

    expect(backoff).toEqual({ type: "fixed", delay: 30_000 });
    expect((attempts - 1) * backoff.delay).toBeGreaterThanOrEqual(7_200_000);
    expect((attempts - 2) * backoff.delay).toBeLessThan(7_200_000);
  });
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

  it("asks nothing when payments are off, since no hold was written", async () => {
    where.payments = false;

    await releaseHere("task-9");

    expect(releaseHold).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });
});

describe("giving up a hold outside the global region", () => {
  it("queues the abandon with the same retry when the global region is unavailable", async () => {
    abandonHold.mockRejectedValue(new GlobalApiError(503, "unavailable", "down"));

    await abandonHere({ studioId: "s-1", actorUserId: "u-1", referenceId: "task-5" });

    expect(queueAdd).toHaveBeenCalledWith(
      "abandon",
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

// inner#1955: a task whose cost is looked up after delivery keeps its hold
// alive; the hold lives in the global region, so the extension goes there.
describe("extending a hold outside the global region", () => {
  const UNTIL = new Date("2026-11-16T10:00:00.000Z");

  it("asks the global region to extend it", async () => {
    await extendHere("task-1", UNTIL);

    expect(extendHold).toHaveBeenCalledWith("task-1", UNTIL.toISOString());
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("queues the extension for retry when the global region is unavailable, apart from the hold's release", async () => {
    extendHold.mockRejectedValue(new GlobalApiError(503, "unavailable", "down"));

    await extendHere("task-1", UNTIL);

    expect(queueAdd).toHaveBeenCalledWith(
      "extend",
      { referenceId: "task-1", extendUntil: UNTIL.toISOString() },
      expect.objectContaining({ ...RETRY, jobId: `task-1:extend:${UNTIL.getTime()}` }),
    );
  });

  it("runs a queued extension through the global region", async () => {
    await runQueuedHoldRelease({ referenceId: "task-1", extendUntil: UNTIL.toISOString() });

    expect(extendHold).toHaveBeenCalledWith("task-1", UNTIL.toISOString());
    expect(releaseHold).not.toHaveBeenCalled();
  });
});

