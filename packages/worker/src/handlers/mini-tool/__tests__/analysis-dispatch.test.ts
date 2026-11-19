// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type * as coreModule from "@breatic/core";
import type * as domainModule from "@breatic/domain";
import type { MiniToolAnalysisJob, miniToolAnalysisService } from "@breatic/domain";
import { MINI_TOOL_ANALYSIS_JOB, miniToolAnalysisRecordSchema } from "@breatic/shared/mini-tools";
import { runTask } from "@worker/handlers/dispatch.js";
import type { MiniToolAnalysisExecutor } from "../run-analysis-task.js";
import { FROZEN_PRESENTATION } from "./frozen-presentation.js";

const h = vi.hoisted(() => ({ analysis: vi.fn(), container: vi.fn(), legacy: vi.fn() }));
vi.mock("@breatic/core", async (original) => ({ ...await original<typeof coreModule>(), getStreamRedis: () => ({}) }));
vi.mock("@breatic/domain", async (original) => {
  const actual = await original<typeof domainModule>();
  return { ...actual, taskService: { ...actual.taskService, getByIdInternal: h.legacy } };
});
vi.mock("@worker/handlers/mini-tool/run-analysis-task.js", () => ({ runMiniToolAnalysisTask: h.analysis }));
vi.mock("@worker/handlers/mini-tool/run-container-analysis.js", () => ({ runMiniToolContainerAnalysis: h.container }));

const TASK = "10000000-0000-4000-8000-000000000001";
const DEADLINE = 1792927200000;

/** Build a valid SQL source independent of the delivery's source and destination. @returns The original accepted analysis. */
function originalExecution(kind: "people" | "scene_cuts"): miniToolAnalysisService.MiniToolAnalysisExecution {
  const profile = { id: "original-profile", version: "original", weightsHash: null, params: {} };
  const url = "https://assets.test.invalid/original.mp4";
  const input = kind === "people" ? { schemaVersion: 1, kind, sourceURL: url, profile, anchor: { frameIndex: 1, pts: 0.25 } }
    : { schemaVersion: 1, kind, sourceURL: url, profile, range: { start: 0, end: 5 } };
  const record = miniToolAnalysisRecordSchema.parse({ schemaVersion: 1, kind, analysisRunId: TASK,
    draftId: "20000000-0000-4000-8000-000000000001", revision: "30000000-0000-4000-8000-000000000001",
    acceptedAt: "2026-10-25T01:02:03.123456Z", inputFingerprint: "a".repeat(64), analysisInput: input,
    binding: { assetId: "40000000-0000-4000-8000-000000000001", contentHash: "b".repeat(64), canonicalURL: url,
      kind: "video", mediaInfo: { width: 400, height: 200, duration: 5, mimeType: "video/mp4" } },
    status: "running", result: null, error: null, usage: [], artifactUnavailable: false });
  const context = { taskId: TASK, userId: "50000000-0000-4000-8000-000000000001", projectId: "60000000-0000-4000-8000-000000000001",
    spaceId: "70000000-0000-4000-8000-000000000001", hostNodeId: "80000000-0000-4000-8000-000000000001" };
  return { record, context, params: { sourceKey: "original/sql-source.mp4", requestFingerprint: "c".repeat(64), credits: 0, analysis: {
    schemaVersion: 1, projectId: context.projectId, spaceId: context.spaceId, hostNodeId: context.hostNodeId,
    analysisRunId: TASK, draftId: record.draftId, revision: record.revision, kind,
    source: { nodeId: context.hostNodeId, canonicalURL: url, mediaInfo: record.binding.mediaInfo },
    binding: record.binding, analysisInput: record.analysisInput, inputFingerprint: record.inputFingerprint,
    ...FROZEN_PRESENTATION,
  } } };
}

beforeEach(() => {
  vi.resetAllMocks(); h.legacy.mockRejectedValue(new Error("Legacy generation path was reached")); h.container.mockResolvedValue({ computed: true });
});

describe("tasks queue analysis discriminator", () => {
  it.each(["people", "scene_cuts"] as const)("routes %s through the original analysis lifecycle and its SQL executor", async (kind) => {
    const original = originalExecution(kind);
    const job = { id: "original-job", name: MINI_TOOL_ANALYSIS_JOB, data: { taskId: TASK, userId: "queue-user", projectId: "queue-project",
      spaceId: "queue-space", hostNodeId: "queue-host", params: { analysis: { kind: "tracked_mask" } }, sourceKey: "different/queue-source.mp4" } } as unknown as Job<MiniToolAnalysisJob>;
    h.analysis.mockImplementation(async (_job: Job<MiniToolAnalysisJob>, _token: string, execute: MiniToolAnalysisExecutor) => {
      expect(await execute(original, DEADLINE)).toEqual({ computed: true });
      return { analysisRunId: TASK, status: "completed" };
    });
    expect(await runTask(job as unknown as Parameters<typeof runTask>[0], "original-token")).toEqual({ analysisRunId: TASK, status: "completed" });
    expect(h.analysis).toHaveBeenCalledExactlyOnceWith(job, "original-token", expect.any(Function));
    expect(h.container).toHaveBeenCalledExactlyOnceWith(original, DEADLINE);
    expect(h.legacy).not.toHaveBeenCalled();
  });

  it("requires the analysis discriminator instead of sending a host payload into generation", async () => {
    const job = { name: "unrelated-task", data: { taskId: TASK, hostNodeId: "original-host" } } as unknown as Parameters<typeof runTask>[0];
    await expect(runTask(job, "token")).rejects.toThrow("Analysis execution requires its job discriminator");
    expect(h.analysis).not.toHaveBeenCalled(); expect(h.legacy).not.toHaveBeenCalled();
  });
});
