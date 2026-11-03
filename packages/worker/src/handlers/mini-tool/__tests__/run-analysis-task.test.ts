// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DelayedError, type Job } from "bullmq";
import type * as coreModule from "@breatic/core";
import type * as domainModule from "@breatic/domain";
import { miniToolStepStateSchema, type MiniToolAnalysisJob, type miniToolAnalysisService } from "@breatic/domain";
import { DeadlinePassed } from "@breatic/shared";
import { miniToolAnalysisRecordSchema, miniToolAnalysisResultSchema, type MiniToolAnalysisResult } from "@breatic/shared/mini-tools";
import { ContainerJobFailed } from "@worker/handlers/container/run-container-job.js";
import { StillRunning } from "@worker/providers/still-running.js";
import { runMiniToolAnalysisTask } from "../run-analysis-task.js";

const h = vi.hoisted(() => ({ start: vi.fn(), finish: vi.fn(), steps: vi.fn(), deadline: vi.fn(), execute: vi.fn(),
  extend: vi.fn(), delay: vi.fn(), error: vi.fn(), warn: vi.fn(), stream: {} }));
vi.mock("@breatic/core", async (original) => {
  const actual = await original<typeof coreModule>();
  return { ...actual, getStreamRedis: () => h.stream, getWorkerConfig: () => ({ lock_duration_ms: 600000 }),
    logger: { ...actual.logger, error: h.error, warn: h.warn } };
});
vi.mock("@breatic/domain", async (original) => {
  const actual = await original<typeof domainModule>();
  return { ...actual, miniToolAnalysisService: { ...actual.miniToolAnalysisService, startMiniToolAnalysisExecution: h.start },
    upstreamStepRepo: { ...actual.upstreamStepRepo, listSteps: h.steps } };
});
vi.mock("@worker/handlers/task-deadline.js", () => ({ taskDeadline: h.deadline }));
vi.mock("@worker/handlers/mini-tool/analysis-completion.js", () => ({ finishMiniToolAnalysisAndNotify: h.finish }));

const TASK = "10000000-0000-4000-8000-000000000001";
const DEADLINE = 1792927200000;
const record = miniToolAnalysisRecordSchema.parse({
  schemaVersion: 1, draftId: "20000000-0000-4000-8000-000000000001", revision: "30000000-0000-4000-8000-000000000001",
  analysisRunId: TASK, acceptedAt: "2026-10-25T01:02:03.123456Z", kind: "people", inputFingerprint: "a".repeat(64),
  binding: { assetId: "40000000-0000-4000-8000-000000000001", contentHash: "b".repeat(64), canonicalURL: "https://assets.test.invalid/original.mp4",
    kind: "video", mediaInfo: { width: 400, height: 200, duration: 12, mimeType: "video/mp4" } },
  analysisInput: { schemaVersion: 1, kind: "people", sourceURL: "https://assets.test.invalid/original.mp4", anchor: { frameIndex: 1, pts: 0.25 },
    profile: { id: "original-profile", version: "original", weightsHash: null, params: {} } },
  status: "running", result: null, error: null, usage: [], artifactUnavailable: false,
});
const result: Extract<MiniToolAnalysisResult, { kind: "people" }> = { schemaVersion: 1, kind: "people", draftId: record.draftId,
  revision: record.revision, analysisRunId: TASK, acceptedAt: record.acceptedAt, binding: record.binding, analysisInput: record.analysisInput,
  inputFingerprint: record.inputFingerprint, anchor: { frameIndex: 1, pts: 0.25 }, people: [] };
const execution: miniToolAnalysisService.MiniToolAnalysisExecution = { record,
  context: { taskId: TASK, userId: "50000000-0000-4000-8000-000000000001", projectId: "60000000-0000-4000-8000-000000000001",
    spaceId: "70000000-0000-4000-8000-000000000001", hostNodeId: "80000000-0000-4000-8000-000000000001" },
  params: { sourceKey: "original/sql-source.mp4", requestFingerprint: "c".repeat(64), credits: 0, analysis: {
    schemaVersion: 1, analysisRunId: TASK, projectId: "60000000-0000-4000-8000-000000000001", spaceId: "70000000-0000-4000-8000-000000000001",
    hostNodeId: "80000000-0000-4000-8000-000000000001", draftId: record.draftId, revision: record.revision, kind: "people",
    source: { nodeId: "80000000-0000-4000-8000-000000000001", canonicalURL: record.binding.canonicalURL, mediaInfo: record.binding.mediaInfo },
    binding: record.binding, analysisInput: record.analysisInput, inputFingerprint: record.inputFingerprint,
  } } };

/** Build a queue envelope whose non-authoritative source differs from the SQL original. @returns The delivery. */
function job(attemptsMade = 0): Job<MiniToolAnalysisJob> {
  return { id: "original-queue-job", name: "execute-mini-tool-analysis", attemptsMade, opts: { attempts: 3 },
    extendLock: h.extend, moveToDelayed: h.delay, data: { taskId: TASK, userId: "queue-user", projectId: "queue-project", spaceId: "queue-space",
      hostNodeId: "queue-host", sourceKey: "different/queue-source.mp4", params: {}, source: "mini_tool" } } as unknown as Job<MiniToolAnalysisJob>;
}

/** Build a tracked analysis whose managed provider attempts determine call-set knowledge. @returns The original record and valid typed result. @throws {Error} When the fixture is invalid. */
function trackedFixture(): { original: miniToolAnalysisService.MiniToolAnalysisExecution; result: MiniToolAnalysisResult } {
  const original = structuredClone(execution);
  const input = { schemaVersion: 1, kind: "tracked_mask", sourceURL: record.binding.canonicalURL, profile: record.analysisInput.profile,
    anchor: { frameIndex: 1, pts: 0.25 }, range: { start: 0, end: 1 },
    region: { box: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 }, points: [] }, trackingPrompt: "selected object" } as const;
  original.record = miniToolAnalysisRecordSchema.parse({ ...record, kind: "tracked_mask", analysisInput: input });
  original.params.analysis = { ...original.params.analysis, kind: "tracked_mask", analysisInput: original.record.analysisInput };
  const metadata = { width: 400, height: 200, frameCount: 4, timeBase: { numerator: 1, denominator: 4 } };
  const computed = miniToolAnalysisResultSchema.parse({
    schemaVersion: 1, kind: "tracked_mask", draftId: record.draftId, revision: record.revision, analysisRunId: TASK,
    acceptedAt: record.acceptedAt, binding: record.binding, analysisInput: input, inputFingerprint: record.inputFingerprint,
    ...metadata, anchor: input.anchor, regionFingerprint: "d".repeat(64), polarity: { remove: 0, keep: 255 },
    sourceFrameMapping: [0, 1, 2, 3].map((frameIndex) => ({ frameIndex, sourcePts: frameIndex / 4 })),
    artifactRefs: ["normalized_clip", "rle", "binary_mask"].map((role, index) => ({
      role, assetId: `90000000-0000-4000-8000-00000000000${index + 1}`, canonicalURL: `https://assets.test.invalid/${role}`,
      contentHash: "e".repeat(64), kind: role === "rle" ? "document" : "video", mimeType: role === "rle" ? "text/plain" : "video/mp4",
      size: 100, frameMetadata: role === "rle" ? null : metadata,
    })),
  });
  return { original, result: computed };
}

beforeEach(() => {
  vi.resetAllMocks(); vi.spyOn(Date, "now").mockReturnValue(DEADLINE - 1);
  h.start.mockResolvedValue(structuredClone(execution)); h.execute.mockResolvedValue(result); h.deadline.mockResolvedValue(DEADLINE);
  h.steps.mockResolvedValue([]); h.extend.mockResolvedValue(1); h.finish.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

// The domain transaction and host notifier have their own PG/protocol tests; these cases observe pickup control flow.
describe("original analysis task pickup", () => {
  it("passes SQL-owned execution and the original budget into computation, then fences completion", async () => {
    expect(await runMiniToolAnalysisTask(job(), "token", h.execute)).toEqual({ analysisRunId: TASK, status: "completed" });
    expect(h.start).toHaveBeenCalledExactlyOnceWith(TASK, "original-queue-job");
    expect(h.deadline).toHaveBeenCalledExactlyOnceWith(TASK, new Date(record.acceptedAt));
    expect(h.execute).toHaveBeenCalledExactlyOnceWith(execution, DEADLINE);
    expect(h.extend).toHaveBeenCalledExactlyOnceWith("token", 600000);
    expect(h.finish).toHaveBeenCalledExactlyOnceWith(TASK, { kind: "result", result, consumptionSet: "complete" }, h.stream);
    expect(h.extend.mock.invocationCallOrder[0]).toBeLessThan(h.finish.mock.invocationCallOrder[0]!);
    expect(result.acceptedAt).toBe("2026-10-25T01:02:03.123456Z");
  });

  it.each([DEADLINE - 1, DEADLINE + 1])("returns a valid upstream wait to the delayed queue at time %s", async (now) => {
    vi.mocked(Date.now).mockReturnValue(now); h.execute.mockRejectedValue(new StillRunning(DEADLINE + 5000));
    await expect(runMiniToolAnalysisTask(job(), "token", h.execute)).rejects.toBeInstanceOf(DelayedError);
    expect(h.delay).toHaveBeenCalledExactlyOnceWith(DEADLINE + 5000, "token");
    expect(h.finish).not.toHaveBeenCalled(); expect(h.steps).not.toHaveBeenCalled();
  });

  it("preserves a tokenless wait for its caller", async () => {
    const waiting = new StillRunning(DEADLINE + 5000); h.execute.mockRejectedValue(waiting);
    await expect(runMiniToolAnalysisTask(job(), undefined, h.execute)).rejects.toBe(waiting);
    expect(h.delay).not.toHaveBeenCalled(); expect(h.finish).not.toHaveBeenCalled();
  });

  it.each([0, 1])("keeps a retryable failure on original attempt %s out of terminal persistence", async (attempt) => {
    const error = new TypeError("JSON connection failed"); h.execute.mockRejectedValue(error);
    await expect(runMiniToolAnalysisTask(job(attempt), "token", h.execute)).rejects.toBe(error);
    expect(h.finish).not.toHaveBeenCalled(); expect(h.error).toHaveBeenCalled();
  });

  it("ends an exhausted container-only computation with its known call-set proof", async () => {
    const error = new Error("registered JSON is invalid"); h.execute.mockRejectedValue(error);
    expect(await runMiniToolAnalysisTask(job(2), "token", h.execute)).toEqual({ failed: true, reason: "analysis_failed" });
    expect(h.finish).toHaveBeenCalledExactlyOnceWith(TASK,
      { kind: "error", error: { code: "analysis_failed", message: error.message }, consumptionSet: "complete" }, h.stream);
  });

  it("ends a known failed original container without starting another error retry", async () => {
    h.execute.mockRejectedValue(new ContainerJobFailed("tool_failed"));
    expect(await runMiniToolAnalysisTask(job(), "token", h.execute)).toEqual({ failed: true, reason: "analysis_failed" });
    expect(h.finish.mock.calls[0]?.[1]).toEqual({ kind: "error", error: { code: "analysis_failed", message: "tool_failed" }, consumptionSet: "complete" });
  });

  it.each([
    { resolution: { kind: "unresolved" }, conflicts: [], expected: "uncertain" },
    { resolution: { kind: "identity", predictionId: "original-prediction" }, conflicts: [], expected: "complete" },
    { resolution: { kind: "rejected", error: { code: "refused" } }, conflicts: [], expected: "complete" },
    { resolution: { kind: "not_sent", error: { code: "expired" } }, conflicts: [], expected: "complete" },
    { resolution: { kind: "identity", predictionId: "original-prediction" }, conflicts: [
      { kind: "identity", attemptId: TASK, canonicalId: "original-prediction", candidateId: "other-prediction" },
    ], expected: "uncertain" },
    { resolution: { kind: "identity", predictionId: "original-prediction" }, conflicts: [
      { kind: "closed_identity", attemptId: TASK, candidateId: "other-prediction" },
    ], expected: "uncertain" },
  ].flatMap((entry) => [{ ...entry, failed: false }, { ...entry, failed: true }]))("keeps persisted submit knowledge $expected after failure=$failed", async ({ resolution, conflicts, expected, failed }) => {
    const tracked = trackedFixture(); h.start.mockResolvedValue(tracked.original); h.execute.mockResolvedValue(tracked.result);
    const state = miniToolStepStateSchema.parse({ schemaVersion: 1,
      scope: { taskId: TASK, stepId: TASK, kind: "generate", endpoint: "original-provider", itemIndex: 0 },
      deadlineAt: DEADLINE, requestBody: {}, requestFingerprint: "a".repeat(64), chargeTo: "user", creditMultiplier: 1,
      attempts: [{ attemptId: TASK, preparedAt: record.acceptedAt, requestFingerprint: "a".repeat(64), resolution }],
      result: null, error: null, conflicts });
    h.steps.mockResolvedValue([{ id: TASK, position: 0, kind: "generate", endpoint: state.scope.endpoint, itemIndex: 0,
      status: resolution.kind === "identity" ? "submitted" : "pending", predictionId: resolution.kind === "identity" ? resolution.predictionId : null,
      inlineCostUsd: 0, output: { miniToolStep: state } }]);
    if (failed) h.execute.mockRejectedValue(new Error("tracked artifact registration failed"));
    expect(await runMiniToolAnalysisTask(job(failed ? 2 : 0), "token", h.execute)).toEqual(failed ? { failed: true, reason: "analysis_failed" } : { analysisRunId: TASK, status: "completed" });
    expect(h.finish.mock.calls[0]?.[1]).toEqual(failed
      ? { kind: "error", error: { code: "analysis_failed", message: "tracked artifact registration failed" }, consumptionSet: expected }
      : { kind: "result", result: tracked.result, consumptionSet: expected });
  });

  it("preserves a failed knowledge read without inventing a complete call set", async () => {
    const error = new Error("step knowledge unavailable"); h.steps.mockRejectedValue(error);
    await expect(runMiniToolAnalysisTask(job(), "token", h.execute)).rejects.toBe(error);
    expect(h.finish).not.toHaveBeenCalled();
  });

  it.each([new DeadlinePassed(), new Error("read failed at the original deadline")])("projects original expiry through the shared completion owner", async (error) => {
    vi.mocked(Date.now).mockReturnValue(DEADLINE); h.execute.mockRejectedValue(error);
    expect(await runMiniToolAnalysisTask(job(), "token", h.execute)).toEqual({ failed: true, reason: "expired" });
    expect(h.finish.mock.calls[0]?.[1]).toMatchObject({ kind: "error", error: { code: "expired" }, consumptionSet: "complete" });
  });

  it.each([false, true])("keeps a reclaimed pickup out of terminal writes after failure=%s", async (failed) => {
    h.extend.mockResolvedValue(0); if (failed) h.execute.mockRejectedValue(new DeadlinePassed());
    expect(await runMiniToolAnalysisTask(job(), "old-token", h.execute)).toEqual({ discarded: true });
    expect(h.finish).not.toHaveBeenCalled();
  });

  it("propagates a Redis fence failure without claiming terminal ownership", async () => {
    const error = new Error("Redis unavailable"); h.extend.mockRejectedValue(error);
    await expect(runMiniToolAnalysisTask(job(), "token", h.execute)).rejects.toBe(error);
    expect(h.finish).not.toHaveBeenCalled();
  });

  it("allows a direct tokenless execution without extending a queue lock", async () => {
    expect(await runMiniToolAnalysisTask(job(), undefined, h.execute)).toEqual({ analysisRunId: TASK, status: "completed" });
    expect(h.extend).not.toHaveBeenCalled(); expect(h.finish).toHaveBeenCalledTimes(1);
  });

  it.each(["completed", "failed"] as const)("replays a persisted %s result without computation or a new budget", async (status) => {
    const original = structuredClone(execution); original.record = miniToolAnalysisRecordSchema.parse({ ...record, status, result,
      error: status === "failed" ? { code: "expired", message: "original expiry" } : null });
    h.start.mockResolvedValue(original);
    expect(await runMiniToolAnalysisTask(job(), "token", h.execute)).toEqual({ analysisRunId: TASK, status });
    expect(h.execute).not.toHaveBeenCalled(); expect(h.deadline).not.toHaveBeenCalled(); expect(h.steps).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledExactlyOnceWith(TASK, { kind: "result", result, consumptionSet: "uncertain" }, h.stream);
  });

  it("replays an original failure without a late result", async () => {
    const original = structuredClone(execution); original.record = miniToolAnalysisRecordSchema.parse({ ...record, status: "failed", error: { code: "expired" } });
    h.start.mockResolvedValue(original);
    expect(await runMiniToolAnalysisTask(job(), "token", h.execute)).toEqual({ analysisRunId: TASK, status: "failed" });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledExactlyOnceWith(TASK, { kind: "error", error: { code: "expired" }, consumptionSet: "uncertain" }, h.stream);
  });

  it("preserves a notification failure and replays the committed result on the next pickup", async () => {
    const error = new Error("notification stream unavailable"); h.finish.mockRejectedValueOnce(error);
    await expect(runMiniToolAnalysisTask(job(), "token", h.execute)).rejects.toBe(error);
    h.start.mockResolvedValue({ ...execution, record: { ...record, status: "completed", result } }); h.execute.mockClear();
    expect(await runMiniToolAnalysisTask(job(), "token", h.execute)).toEqual({ analysisRunId: TASK, status: "completed" });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each(["start", "budget"])('preserves an original %s infrastructure failure', async (stage) => {
    const error = new Error(`${stage} storage unavailable`);
    (stage === "start" ? h.start : h.deadline).mockRejectedValue(error);
    await expect(runMiniToolAnalysisTask(job(), "token", h.execute)).rejects.toBe(error);
    expect(h.execute).not.toHaveBeenCalled(); expect(h.finish).not.toHaveBeenCalled();
  });
});
