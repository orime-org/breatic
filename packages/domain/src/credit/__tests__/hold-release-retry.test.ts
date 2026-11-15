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
const where = vi.hoisted(() => ({ region: "sg" }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof coreModule>();
  return {
    ...actual,
    isGlobalRegion: () => where.region === "us-west",
    createQueue: () => ({ add: queueAdd }),
    defaultJobOpts: () => ({ attempts: 5 }),
  };
});
vi.mock("@domain/region/global-api.js", () => ({ globalApi: () => ({ releaseHold }) }));

import { GlobalApiError } from "@breatic/core";
import { CREDIT_HOLD_RELEASE_QUEUE, releaseHold as releaseHere } from "@domain/credit/creditHold.service.js";

beforeEach(() => {
  queueAdd.mockClear();
  releaseHold.mockReset();
  where.region = "sg";
});

describe("releasing a hold outside the global region", () => {
  it("queues the release for retry when the global region is unavailable", async () => {
    releaseHold.mockRejectedValue(new GlobalApiError(503, "unavailable", "down"));

    await releaseHere("task-1");

    expect(queueAdd).toHaveBeenCalledWith("release", { referenceId: "task-1" }, expect.objectContaining({ jobId: "task-1", attempts: 5 }));
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
