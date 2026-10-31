// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Queue, Job } from "bullmq";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";

const mocks = vi.hoisted(() => ({
  applyDispatch: vi.fn(),
  getUnderstandConfig: vi.fn(),
  listDue: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    getUnderstandConfig: mocks.getUnderstandConfig,
    defaultJobOpts: () => ({
      attempts: 3,
      backoff: { type: "jitter" },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400, count: 1000 },
    }),
    logger: { ...actual.logger, error: mocks.loggerError },
  };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return {
    ...actual,
    applyUnderstandDispatchEvent: mocks.applyDispatch,
    listDueUnderstandDispatches: mocks.listDue,
  };
});

import { getUnderstandConfig } from "@breatic/core";
import { runLongMediaDispatchSweep } from "@worker/handlers/long-media-dispatch.js";

/** Create a BullMQ shape with only the calls the sweep needs. */
function makeQueue(): Queue {
  return {
    add: vi.fn().mockResolvedValue({ id: "lm_op-1_4" }),
    getJob: vi.fn().mockResolvedValue(undefined),
  } as unknown as Queue;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUnderstandConfig.mockReturnValue({ long_media: { delivery_concurrency: 2 } });
  mocks.listDue.mockResolvedValue([{ operationId: "op-1", revision: 7, sequence: 4 }]);
  mocks.applyDispatch.mockResolvedValue({ id: "op-1", dispatchState: "sent" });
});

describe("runLongMediaDispatchSweep", () => {
  it("sends a stable operation wake before marking the SQL outbox sent", async () => {
    const queue = makeQueue();

    expect(await runLongMediaDispatchSweep(queue)).toBe(1);
    expect(mocks.listDue).toHaveBeenCalledWith(2);
    expect(queue.add).toHaveBeenCalledWith(
      "long-media-operation",
      { operationId: "op-1", wakeSequence: 4 },
      expect.objectContaining({ jobId: "lm_op-1_4", attempts: 3 }),
    );
    expect(mocks.applyDispatch).toHaveBeenCalledWith("op-1", expect.objectContaining({
      type: "dispatch", expectedRevision: 7, operationId: "op-1",
    }));
    expect(getUnderstandConfig).toHaveBeenCalledOnce();
  });

  it("removes a retained failed job before replaying the same stable wake", async () => {
    const failed = { isFailed: vi.fn().mockResolvedValue(true), remove: vi.fn().mockResolvedValue(undefined) } as unknown as Job;
    const queue = makeQueue();
    vi.mocked(queue.getJob).mockResolvedValue(failed);

    expect(await runLongMediaDispatchSweep(queue)).toBe(1);
    expect(failed.remove).toHaveBeenCalledOnce();
    expect(queue.add).toHaveBeenCalledWith(
      "long-media-operation",
      { operationId: "op-1", wakeSequence: 4 },
      expect.objectContaining({ jobId: "lm_op-1_4" }),
    );
  });

  it("records retry due time and logs when Redis delivery fails", async () => {
    const queue = makeQueue();
    vi.mocked(queue.add).mockRejectedValue(new Error("redis unavailable"));

    expect(await runLongMediaDispatchSweep(queue)).toBe(0);
    expect(mocks.applyDispatch).toHaveBeenCalledWith("op-1", expect.objectContaining({
      type: "send-failure", expectedRevision: 7,
    }));
    expect(mocks.loggerError).toHaveBeenCalledOnce();
  });
});
