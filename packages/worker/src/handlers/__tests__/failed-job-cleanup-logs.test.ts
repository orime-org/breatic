// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the crash net writes down when it cannot finish (#186, design §3.6).
 *
 * This runs when the worker that owned a job is already gone, so it is the
 * last thing that will touch those task rows. Each node is attempted on its
 * own and a failure moves on to the next, which is right — but the reason has
 * to be written here, because nothing above this catches it and the row it
 * missed goes on counting until somebody opens that node's task list.
 *
 * No real Redis / DB — everything is mocked.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const mockSettleTaskForNode = vi.hoisted(() => vi.fn());
const mockActivityInsert = vi.hoisted(() => vi.fn());
const mockPublishActivity = vi.hoisted(() => vi.fn());
const mockError = vi.hoisted(() => vi.fn());
const mockGetTask = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());

vi.mock("@breatic/core", () => ({
  getStreamRedis: vi.fn(() => ({})),
  projectActivitiesRepo: {
    insertGenerationFailedIfAbsent: mockActivityInsert,
    upsertGenerationSucceeded: vi.fn(),
  },
  publishActivityNew: mockPublishActivity,
  logger: { info: vi.fn(), warn: mockWarn, error: mockError, debug: vi.fn() },
}));
vi.mock("@breatic/domain", () => ({
  // The billed-then-crashed branch reads this first: a job that was already
  // paid for must not be stamped failed over its result.
  taskService: { getByIdInternal: mockGetTask },
  settleTaskForNode: mockSettleTaskForNode,
}));
vi.mock("@breatic/shared", () => ({
  canvasSpaceDocName: (p: string, s: string) => `project-${p}/canvas-${s}`,
}));
const mockRecordGeneration = vi.hoisted(() => vi.fn());
vi.mock("@worker/handlers/dispatch.js", () => ({
  mediaKindForActivity: vi.fn(() => "image"),
  recordGenerationForNodes: mockRecordGeneration,
}));

import { cleanupFailedJobNodes } from "@worker/handlers/failed-job-cleanup.js";
import type { FailedJobLike } from "@worker/handlers/failed-job-cleanup.js";

/**
 * A terminally failed job carrying two target nodes.
 * @returns The job shape this handler reads.
 */
function job(): FailedJobLike {
  return {
    data: {
      taskId: "task-1",
      userId: "user-1",
      projectId: "proj-1",
      spaceId: "space-1",
      targetNodeIds: ["node-1", "node-2"],
      taskType: "image",
    },
    finishedOn: Date.now(),
  } as unknown as FailedJobLike;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockActivityInsert.mockResolvedValue(true);
  mockGetTask.mockResolvedValue(null);
});

describe("cleanupFailedJobNodes, when settling a row fails", () => {
  it("writes down which node it could not settle", async () => {
    mockSettleTaskForNode
      .mockRejectedValueOnce(new Error("stream is gone"))
      .mockResolvedValueOnce(undefined);

    await cleanupFailedJobNodes({} as never, job(), "provider said no");

    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", nodeId: "node-1" }),
      expect.stringContaining("node_task settle"),
    );
  });

  it("carries on to the remaining nodes", async () => {
    mockSettleTaskForNode
      .mockRejectedValueOnce(new Error("stream is gone"))
      .mockResolvedValueOnce(undefined);

    const emitted = await cleanupFailedJobNodes({} as never, job(), "provider said no");

    expect(mockSettleTaskForNode).toHaveBeenCalledTimes(2);
    expect(emitted).toBe(1);
  });

  it("writes down an activity row it could not record", async () => {
    mockActivityInsert.mockRejectedValue(new Error("db is gone"));
    mockSettleTaskForNode.mockResolvedValue(undefined);

    await cleanupFailedJobNodes({} as never, job(), "provider said no");

    // The row is written through the if-absent call, so that a crash net
    // running after a success cannot stamp a failure over it.
    expect(mockActivityInsert).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", projectId: "proj-1" }),
      expect.stringContaining("activity"),
    );
  });
});

describe("cleanupFailedJobNodes, delivering a run that was billed before the crash", () => {
  // The row this writes is the only history the reader gets for that run, and
  // its second line names the model. A reading's stored result says nothing
  // about the model — the run's answer is text and a finish reason — so the
  // name has to come from the job, which is where the two live deliveries
  // read it from.
  it("names the model the job ran on when the result did not say", async () => {
    mockGetTask.mockResolvedValue({
      userId: "user-1",
      billedAt: new Date(),
      billedCredits: 12,
      durationMs: 4200,
      params: { source_type: "image" },
      result: { outputs: [{ content: "A red bicycle." }] },
    });

    await cleanupFailedJobNodes({} as never, understandJob(), "worker died");

    expect(mockRecordGeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        metadata: expect.objectContaining({ model: "google/gemini-3.8-flash" }),
      }),
      expect.anything(),
    );
  });
});

/**
 * A terminally failed reading, billed before the worker went.
 * @returns The job shape this handler reads.
 */
function understandJob(): FailedJobLike {
  return {
    data: {
      taskId: "task-1",
      userId: "user-1",
      projectId: "proj-1",
      spaceId: "space-1",
      targetNodeIds: ["node-1"],
      taskType: "understand",
      model: "google/gemini-3.8-flash",
    },
    finishedOn: Date.now(),
  } as unknown as FailedJobLike;
}
