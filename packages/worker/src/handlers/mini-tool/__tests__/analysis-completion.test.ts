// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as domainModule from "@breatic/domain";
import type * as coreModule from "@breatic/core";
import { NO_CONSENT } from "@breatic/shared";
import { miniToolAnalysisRecordSchema } from "@breatic/shared/mini-tools";
import type { MiniToolAnalysisRecord } from "@breatic/shared/mini-tools";
import { finishMiniToolAnalysisAndNotify } from "../analysis-completion.js";
import { cleanupFailedJobNodes, reclaimFailedJobById, type FailedJobLike } from "@worker/handlers/failed-job-cleanup.js";

const h = vi.hoisted(() => ({ finish: vi.fn(), settle: vi.fn(), releaseHold: vi.fn(), getTask: vi.fn(), history: vi.fn(), activity: vi.fn(), error: vi.fn() }));
vi.mock("@breatic/domain", async (original) => {
  const actual = await original<typeof domainModule>();
  return { ...actual, miniToolAnalysisService: { ...actual.miniToolAnalysisService, finishMiniToolAnalysis: h.finish },
    settleTaskForNode: h.settle, creditHoldService: { ...actual.creditHoldService, releaseHold: h.releaseHold },
    taskService: { ...actual.taskService, getByIdInternal: h.getTask },
    nodeHistoryService: { ...actual.nodeHistoryService, recordGenerationSuccess: h.history, recordGenerationFailure: h.history } };
});
vi.mock("@breatic/core", async (original) => ({
  ...await original<typeof coreModule>(), logger: { error: h.error, warn: vi.fn(), info: vi.fn() },
  projectActivitiesRepo: { insertGenerationFailedIfAbsent: h.activity, upsertGenerationSucceeded: h.activity },
}));
vi.mock("@worker/handlers/dispatch.js", () => ({
  releaseRunHold: h.releaseHold, recordGenerationForNodes: h.history, mediaKindForActivity: () => "video",
}));

const taskId = "10000000-0000-4000-8000-000000000001";
const context = {
  taskId, userId: "20000000-0000-4000-8000-000000000001", projectId: "30000000-0000-4000-8000-000000000001",
  spaceId: "40000000-0000-4000-8000-000000000001", hostNodeId: "50000000-0000-4000-8000-000000000001",
};
const sourceURL = "https://assets.test.invalid/video/source.mp4";
const identity = {
  schemaVersion: 1, draftId: "60000000-0000-4000-8000-000000000001", revision: "70000000-0000-4000-8000-000000000001",
  analysisRunId: taskId, acceptedAt: "2026-10-25T00:00:00.123456Z", kind: "scene_cuts", inputFingerprint: "a".repeat(64),
  binding: { assetId: "80000000-0000-4000-8000-000000000001", contentHash: "b".repeat(64), canonicalURL: sourceURL, kind: "video", mediaInfo: { width: 320, height: 180, duration: 5, mimeType: "video/mp4" } },
  analysisInput: { schemaVersion: 1, kind: "scene_cuts", sourceURL, range: { start: 0, end: 5 }, profile: { id: "detector", version: "1", weightsHash: null, params: {} } },
};
const record = miniToolAnalysisRecordSchema.parse({ ...identity, status: "failed", result: null, error: { code: "analysis_failed", message: "worker stopped" }, usage: [], artifactUnavailable: false });
const ready = miniToolAnalysisRecordSchema.parse({ ...record, status: "completed", error: null, result: { ...identity, fps: { numerator: 25, denominator: 1 }, frameCount: 125, cuts: [] } });
const stream = {} as ReturnType<typeof coreModule.getStreamRedis>;
const docName = `project-${context.projectId}/canvas-${context.spaceId}`;

/** The actual queued analysis shape can carry context older than the committed SQL row. */
function analysisJob(finishedOn: number | undefined = 123): FailedJobLike {
  return { name: "execute-mini-tool-analysis", finishedOn,
    data: { taskId, userId: "old-actor", projectId: "old-project", spaceId: "old-space", hostNodeId: "old-host", source: "mini_tool",
      sourceKey: "video/old-source.mp4", analyticsConsent: NO_CONSENT, params: { analysis: {}, requestFingerprint: "c".repeat(64), sourceKey: "video/old-source.mp4", credits: 1 } } } as unknown as FailedJobLike;
}

beforeEach(() => {
  vi.resetAllMocks();
  h.finish.mockResolvedValue({ record, context }); h.settle.mockResolvedValue(undefined); h.releaseHold.mockResolvedValue(undefined); h.getTask.mockResolvedValue(null);
});

describe("committed analysis host notifications", () => {
  it("publishes the original SQL host after atomically committing a failed outcome", async () => {
    const completion = { kind: "error", error: { code: "analysis_failed", message: "worker stopped" } } as const;
    await finishMiniToolAnalysisAndNotify(taskId, completion, stream);
    expect(h.finish).toHaveBeenCalledExactlyOnceWith(taskId, completion);
    expect(h.settle).toHaveBeenCalledExactlyOnceWith(stream, docName, { taskId, nodeId: context.hostNodeId, outcome: "failed", errorMessage: "worker stopped" });
    expect(h.finish.mock.invocationCallOrder[0]).toBeLessThan(h.settle.mock.invocationCallOrder[0]!);
    expect(h.releaseHold).not.toHaveBeenCalled(); expect(h.history).not.toHaveBeenCalled();
  });

  it("publishes a completed metadata outcome with the host's normal task result shape", async () => {
    h.finish.mockResolvedValue({ record: ready, context });
    await finishMiniToolAnalysisAndNotify(taskId, { kind: "result", result: ready.result }, stream);
    expect(h.settle).toHaveBeenCalledExactlyOnceWith(stream, docName, { taskId, nodeId: context.hostNodeId, outcome: "done" });
    expect(h.releaseHold).not.toHaveBeenCalled(); expect(h.history).not.toHaveBeenCalled();
  });

  it("keeps an earlier success when the crash notification arrives later", async () => {
    h.finish.mockResolvedValue({ record: ready, context });
    await finishMiniToolAnalysisAndNotify(taskId, { kind: "error", error: { code: "later_failure" } }, stream);
    expect(h.settle).toHaveBeenCalledExactlyOnceWith(stream, docName, { taskId, nodeId: context.hostNodeId, outcome: "done" });
  });

  it("publishes the expired cause from the committed record", async () => {
    h.finish.mockResolvedValue({ record: { ...record, error: { code: "expired" } }, context });
    await finishMiniToolAnalysisAndNotify(taskId, { kind: "error", error: { code: "expired" } }, stream);
    expect(h.settle).toHaveBeenCalledExactlyOnceWith(stream, docName, { taskId, nodeId: context.hostNodeId, outcome: "expired", errorMessage: "expired" });
  });

  it("keeps the committed cause when a later failure differs", async () => {
    const original: MiniToolAnalysisRecord = { ...record, error: { code: "original_failure" } };
    h.finish.mockResolvedValue({ record: original, context });
    await finishMiniToolAnalysisAndNotify(taskId, { kind: "error", error: { code: "later_failure" } }, stream);
    expect(h.settle.mock.calls[0]?.[2]).toEqual({ taskId, nodeId: context.hostNodeId, outcome: "failed", errorMessage: "original_failure" });
  });

  it("logs a failed metadata commit and preserves its original exception", async () => {
    const error = new Error("SQL unavailable"); h.finish.mockRejectedValue(error);
    await expect(finishMiniToolAnalysisAndNotify(taskId, { kind: "error", error: { code: "analysis_failed" } }, stream)).rejects.toBe(error);
    expect(h.settle).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ err: error, ctx: expect.objectContaining({ taskId, phase: "commit" }) }), expect.any(String));
  });

  it("logs a failed host notification with its persisted routing context", async () => {
    const error = new Error("stream unavailable"); h.settle.mockRejectedValue(error);
    await expect(finishMiniToolAnalysisAndNotify(taskId, { kind: "error", error: { code: "analysis_failed" } }, stream)).rejects.toBe(error);
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ err: error, ctx: expect.objectContaining({ ...context, phase: "notify" }) }), expect.any(String));
    expect(h.finish).toHaveBeenCalledTimes(1);
  });
});

describe("cross-process analysis failed-job recovery", () => {
  it("fetches the actual terminal job and routes through the common analysis owner", async () => {
    const job = analysisJob(); const queue = { getJob: vi.fn().mockResolvedValue(job) };
    expect(await reclaimFailedJobById(queue, stream, "queue-job-id", "worker died")).toBe(1);
    expect(queue.getJob).toHaveBeenCalledExactlyOnceWith("queue-job-id");
    expect(h.finish).toHaveBeenCalledExactlyOnceWith(taskId, { kind: "error", error: { code: "analysis_failed", message: "worker died" } });
    expect(h.settle).toHaveBeenCalledExactlyOnceWith(stream, docName, { taskId, nodeId: context.hostNodeId, outcome: "failed", errorMessage: "worker stopped" });
    expect(h.releaseHold).not.toHaveBeenCalled(); expect(h.activity).not.toHaveBeenCalled(); expect(h.history).not.toHaveBeenCalled();
  });

  it("handles terminal stalled death even with zero ordinary attempts", async () => {
    const job = { ...analysisJob(), attemptsMade: 0 };
    expect(await cleanupFailedJobNodes(stream, job, "stalled more than allowable limit")).toBe(1);
    expect(h.finish).toHaveBeenCalledTimes(1); expect(h.releaseHold).not.toHaveBeenCalled();
  });

  it("keeps a retrying analysis pending until its terminal event", async () => {
    const job = analysisJob(); delete job.finishedOn;
    expect(await cleanupFailedJobNodes(stream, job, "retry pending")).toBe(0);
    expect(h.finish).not.toHaveBeenCalled(); expect(h.settle).not.toHaveBeenCalled(); expect(h.releaseHold).not.toHaveBeenCalled();
  });

  it("keeps an absent queue job unchanged", async () => {
    expect(await reclaimFailedJobById({ getJob: vi.fn().mockResolvedValue(undefined) }, stream, "gone-job", "worker died")).toBe(0);
    expect(h.finish).not.toHaveBeenCalled(); expect(h.releaseHold).not.toHaveBeenCalled();
  });

  it("uses the committed successful outcome on repeated terminal delivery", async () => {
    h.finish.mockResolvedValue({ record: ready, context });
    for (let repeat = 0; repeat < 3; repeat++) expect(await cleanupFailedJobNodes(stream, analysisJob(), "worker died")).toBe(1);
    expect(h.settle.mock.calls.map((call) => call[2])).toEqual(Array.from({ length: 3 }, () => ({ taskId, nodeId: context.hostNodeId, outcome: "done" })));
    expect(h.releaseHold).not.toHaveBeenCalled(); expect(h.history).not.toHaveBeenCalled();
  });

  it("preserves a SQL failure before routing any host event", async () => {
    const error = new Error("SQL unavailable"); h.finish.mockRejectedValue(error);
    await expect(reclaimFailedJobById({ getJob: vi.fn().mockResolvedValue(analysisJob()) }, stream, "queue-job-id", "worker died")).rejects.toBe(error);
    expect(h.settle).not.toHaveBeenCalled(); expect(h.releaseHold).not.toHaveBeenCalled();
  });
});
