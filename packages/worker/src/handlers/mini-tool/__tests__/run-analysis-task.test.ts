// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DelayedError, type Job } from "bullmq";
import type * as coreModule from "@breatic/core";
import type * as domainModule from "@breatic/domain";
import type { MiniToolAnalysisJob, miniToolAnalysisService } from "@breatic/domain";
import { DeadlinePassed } from "@breatic/shared";
import { miniToolAnalysisRecordSchema, type MiniToolAnalysisResult } from "@breatic/shared/mini-tools";
import { ContainerJobFailed } from "@worker/handlers/container/run-container-job.js";
import { StillRunning } from "@worker/handlers/still-running.js";
import { runMiniToolAnalysisTask } from "../run-analysis-task.js";
import { FROZEN_PRESENTATION } from "./frozen-presentation.js";

const h = vi.hoisted(() => ({ gate: vi.fn(), start: vi.fn(), finish: vi.fn(), deadline: vi.fn(), execute: vi.fn(),
  extend: vi.fn(), delay: vi.fn(), error: vi.fn(), warn: vi.fn(), stream: {} }));
vi.mock("@breatic/core", async (original) => {
  const actual = await original<typeof coreModule>();
  return { ...actual, getStreamRedis: () => h.stream, getWorkerConfig: () => ({ lock_duration_ms: 600000 }),
    logger: { ...actual.logger, error: h.error, warn: h.warn } };
});
vi.mock("@breatic/domain", async (original) => {
  const actual = await original<typeof domainModule>();
  return { ...actual, runningSlotService: { ...actual.runningSlotService, startWithinLimit: h.gate },
    miniToolAnalysisService: { ...actual.miniToolAnalysisService, startMiniToolAnalysisExecution: h.start } };
});
vi.mock("@worker/handlers/task-deadline.js", () => ({ taskDeadline: h.deadline }));
vi.mock("@worker/handlers/mini-tool/analysis-completion.js", () => ({ finishMiniToolAnalysisAndNotify: h.finish }));

const TASK = "10000000-0000-4000-8000-000000000001";
const DEADLINE = 1792927200000;
// The start the running-task gate gave the analysis; its budget counts from here (inner#1968 design 3.9).
const STARTED = new Date("2026-10-25T01:05:00.000Z");
const record = miniToolAnalysisRecordSchema.parse({
  schemaVersion: 1, draftId: "20000000-0000-4000-8000-000000000001", revision: "30000000-0000-4000-8000-000000000001",
  analysisRunId: TASK, acceptedAt: "2026-10-25T01:02:03.123456Z", kind: "scene_cuts", inputFingerprint: "a".repeat(64),
  binding: { assetId: "40000000-0000-4000-8000-000000000001", contentHash: "b".repeat(64), canonicalURL: "https://assets.test.invalid/original.mp4",
    kind: "video", mediaInfo: { width: 400, height: 200, duration: 12, mimeType: "video/mp4" } },
  analysisInput: { schemaVersion: 1, kind: "scene_cuts", sourceURL: "https://assets.test.invalid/original.mp4", range: { start: 0, end: 5 },
    profile: { id: "original-profile", version: "original", weightsHash: null, params: {} } },
  status: "running", result: null, error: null, usage: [], artifactUnavailable: false,
});
const result: MiniToolAnalysisResult = { schemaVersion: 1, kind: "scene_cuts", draftId: record.draftId,
  revision: record.revision, analysisRunId: TASK, acceptedAt: record.acceptedAt, binding: record.binding, analysisInput: record.analysisInput,
  inputFingerprint: record.inputFingerprint, fps: { numerator: 25, denominator: 1 }, frameCount: 300, cuts: [] };
const execution: miniToolAnalysisService.MiniToolAnalysisExecution = { record,
  context: { taskId: TASK, userId: "50000000-0000-4000-8000-000000000001", projectId: "60000000-0000-4000-8000-000000000001",
    spaceId: "70000000-0000-4000-8000-000000000001", hostNodeId: "80000000-0000-4000-8000-000000000001" },
  params: { sourceKey: "original/sql-source.mp4", requestFingerprint: "c".repeat(64), credits: 0, analysis: {
    schemaVersion: 1, analysisRunId: TASK, projectId: "60000000-0000-4000-8000-000000000001", spaceId: "70000000-0000-4000-8000-000000000001",
    hostNodeId: "80000000-0000-4000-8000-000000000001", draftId: record.draftId, revision: record.revision, kind: "scene_cuts",
    source: { nodeId: "80000000-0000-4000-8000-000000000001", canonicalURL: record.binding.canonicalURL, mediaInfo: record.binding.mediaInfo },
    binding: record.binding, analysisInput: record.analysisInput, inputFingerprint: record.inputFingerprint,
    ...FROZEN_PRESENTATION, chargeTo: "user",
  } } };

/** Build a queue envelope whose non-authoritative source differs from the SQL original. @returns The delivery. */
function job(attemptsMade = 0): Job<MiniToolAnalysisJob> {
  return { id: "original-queue-job", name: "execute-mini-tool-analysis", attemptsMade, opts: { attempts: 3 },
    extendLock: h.extend, moveToDelayed: h.delay, data: { taskId: TASK, userId: "queue-user", projectId: "queue-project", spaceId: "queue-space",
      hostNodeId: "queue-host", sourceKey: "different/queue-source.mp4", params: {}, source: "mini_tool" } } as unknown as Job<MiniToolAnalysisJob>;
}

beforeEach(() => {
  vi.resetAllMocks(); vi.spyOn(Date, "now").mockReturnValue(DEADLINE - 1);
  h.start.mockResolvedValue(structuredClone(execution)); h.execute.mockResolvedValue(result); h.deadline.mockResolvedValue(DEADLINE);
  h.extend.mockResolvedValue(1); h.finish.mockResolvedValue(undefined);
  h.gate.mockResolvedValue({ outcome: "started", started: STARTED, publishFailures: [] });
});
afterEach(() => vi.restoreAllMocks());

// The domain transaction and host notifier have their own PG/protocol tests; these cases observe pickup control flow.
describe("original analysis task pickup", () => {
  it("passes SQL-owned execution and the original budget into computation, then fences completion", async () => {
    expect(await runMiniToolAnalysisTask(job(), "token", h.execute)).toEqual({ analysisRunId: TASK, status: "completed" });
    expect(h.start).toHaveBeenCalledExactlyOnceWith(TASK, "original-queue-job");
    expect(h.deadline).toHaveBeenCalledExactlyOnceWith(TASK, STARTED);
    expect(h.execute).toHaveBeenCalledExactlyOnceWith(execution, DEADLINE);
    expect(h.extend).toHaveBeenCalledExactlyOnceWith("token", 600000);
    expect(h.finish).toHaveBeenCalledExactlyOnceWith(TASK, { kind: "result", result }, h.stream);
    expect(h.extend.mock.invocationCallOrder[0]).toBeLessThan(h.finish.mock.invocationCallOrder[0]!);
    expect(result.acceptedAt).toBe("2026-10-25T01:02:03.123456Z");
  });

  it("M2-04 asks the running-task gate with its job before the pickup starts the analysis", async () => {
    await runMiniToolAnalysisTask(job(), "token", h.execute);
    expect(h.gate).toHaveBeenCalledExactlyOnceWith({ id: TASK, jobId: "original-queue-job" });
    expect(h.gate.mock.invocationCallOrder[0]).toBeLessThan(h.start.mock.invocationCallOrder[0]!);
  });

  it("M2-05 an analysis that must wait goes back on the delayed queue without starting", async () => {
    h.gate.mockRejectedValue(new StillRunning(DEADLINE + 3000));
    await expect(runMiniToolAnalysisTask(job(), "token", h.execute)).rejects.toBeInstanceOf(DelayedError);
    expect(h.delay).toHaveBeenCalledExactlyOnceWith(DEADLINE + 3000, "token");
    expect(h.start).not.toHaveBeenCalled(); expect(h.execute).not.toHaveBeenCalled(); expect(h.error).not.toHaveBeenCalled();
  });

  it.each([DEADLINE - 1, DEADLINE + 1])("returns a valid upstream wait to the delayed queue at time %s", async (now) => {
    vi.mocked(Date.now).mockReturnValue(now); h.execute.mockRejectedValue(new StillRunning(DEADLINE + 5000));
    await expect(runMiniToolAnalysisTask(job(), "token", h.execute)).rejects.toBeInstanceOf(DelayedError);
    expect(h.delay).toHaveBeenCalledExactlyOnceWith(DEADLINE + 5000, "token");
    expect(h.finish).not.toHaveBeenCalled();
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

  it("ends an exhausted container-only computation with its error", async () => {
    const error = new Error("registered JSON is invalid"); h.execute.mockRejectedValue(error);
    expect(await runMiniToolAnalysisTask(job(2), "token", h.execute)).toEqual({ failed: true, reason: "analysis_failed" });
    expect(h.finish).toHaveBeenCalledExactlyOnceWith(TASK,
      { kind: "error", error: { code: "analysis_failed", message: error.message } }, h.stream);
  });

  it("ends a known failed original container without starting another error retry", async () => {
    h.execute.mockRejectedValue(new ContainerJobFailed("tool_failed"));
    expect(await runMiniToolAnalysisTask(job(), "token", h.execute)).toEqual({ failed: true, reason: "analysis_failed" });
    expect(h.finish.mock.calls[0]?.[1]).toEqual({ kind: "error", error: { code: "analysis_failed", message: "tool_failed" } });
  });

  it.each([new DeadlinePassed(), new Error("read failed at the original deadline")])("projects original expiry through the shared completion owner", async (error) => {
    vi.mocked(Date.now).mockReturnValue(DEADLINE); h.execute.mockRejectedValue(error);
    expect(await runMiniToolAnalysisTask(job(), "token", h.execute)).toEqual({ failed: true, reason: "expired" });
    expect(h.finish.mock.calls[0]?.[1]).toMatchObject({ kind: "error", error: { code: "expired" } });
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
    expect(h.execute).not.toHaveBeenCalled(); expect(h.deadline).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledExactlyOnceWith(TASK, { kind: "result", result }, h.stream);
  });

  // A detection the user cancelled while it waited for a running slot is picked up once more by its delayed job (frames-split
  // §7.19 analysis row): it ends as it stands, as a cancelled planned run does.
  it("ends a cancelled analysis as it stands: no computation, grant or notification", async () => {
    const cancelled = structuredClone(execution); cancelled.record = miniToolAnalysisRecordSchema.parse({ ...record, status: "cancelled" });
    h.start.mockResolvedValue(cancelled);
    h.gate.mockResolvedValue({ outcome: "ended", publishFailures: [] });
    expect(await runMiniToolAnalysisTask(job(), "token", h.execute)).toEqual({ analysisRunId: TASK, status: "cancelled" });
    expect(h.execute).not.toHaveBeenCalled(); expect(h.finish).not.toHaveBeenCalled(); expect(h.error).not.toHaveBeenCalled();
  });

  it("replays an original failure without a late result", async () => {
    const original = structuredClone(execution); original.record = miniToolAnalysisRecordSchema.parse({ ...record, status: "failed", error: { code: "expired" } });
    h.start.mockResolvedValue(original);
    expect(await runMiniToolAnalysisTask(job(), "token", h.execute)).toEqual({ analysisRunId: TASK, status: "failed" });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledExactlyOnceWith(TASK, { kind: "error", error: { code: "expired" } }, h.stream);
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
