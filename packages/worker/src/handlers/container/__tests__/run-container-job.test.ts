// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A mini-tool container run (inner#888 §8.1, A13, A14): one job per task
 * however many attempts read it, outputs filed through the report handler,
 * and a charge computed from the run's measured usage.
 */

import type * as sharedModule from "@breatic/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  steps: [] as Array<{ id: string; status: string; output: Record<string, unknown> }>,
  ensureSteps: vi.fn(),
  recordInline: vi.fn(),
  markDone: vi.fn(),
  markFailed: vi.fn(),
  openContainerOutputs: vi.fn(),
  applyIngestReport: vi.fn(),
  readMiniToolJob: vi.fn(),
  submitMiniToolJob: vi.fn(),
  recordServiceCall: vi.fn(),
}));

vi.mock("node:timers/promises", () => ({ setTimeout: async (): Promise<void> => {} }));

vi.mock("@breatic/core", () => ({
  env: { INGEST_BASE_URL: "https://ingest.test", INGEST_SHARED_SECRET: "s", CREDIT_MULTIPLIER: 2 },
  logger: { warn: vi.fn(), error: vi.fn() },
  getMiniToolsConfig: () => ({
    poll_interval_ms: 1000,
    prices: { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.0000025, disk_gb_second_usd: 0.00000007 },
    classes: { Std1: { instance_type: "standard-1", vcpu: 0.5, memory_gib: 4, disk_gb: 8 } },
    ops: { cut: { container_class: "Std1", job_deadline_ms: 600_000, precheck_seconds: 300 } },
  }),
}));

vi.mock("@breatic/domain", () => ({
  assetService: { mediaLimits: () => ({ runDeadlineMs: 1, toolTimeoutMs: 1 }) },
  creditsForUsd: (usd: number, multiplier: number) => usd * 100 * multiplier,
  createUsageRecorder: () => ({ recordServiceCall: h.recordServiceCall, settle: async () => 0 }),
  ingestReportService: { applyIngestReport: h.applyIngestReport },
  openContainerOutputs: h.openContainerOutputs,
  upstreamStepRepo: {
    ensureSteps: h.ensureSteps,
    recordInline: h.recordInline,
    markDone: h.markDone,
    markFailed: h.markFailed,
  },
}));

vi.mock("@breatic/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof sharedModule>()),
  readMiniToolJob: h.readMiniToolJob,
  submitMiniToolJob: h.submitMiniToolJob,
}));

import { UploadHttpError } from "@breatic/shared";
import { miniToolById, type MiniToolSpec } from "@breatic/shared/mini-tools";

import { ContainerJobFailed, runContainerJob } from "@worker/handlers/container/run-container-job.js";

const CUT = miniToolById("video.cut") as MiniToolSpec;
const INPUT = { taskId: "t1", userId: "u1", projectId: "p1", params: { range: { start: 0, end: 2 } }, sourceKey: "v/src.mp4" };
const OUT = { storageKey: "video/out.mp4", contentType: "video/mp4", coverKey: "video/out.cover.jpg" };
const USAGE = { wallMs: 10_000, cpuUsec: 4_000_000 };
const MEASURED = { storageKey: OUT.storageKey, sha256: "a".repeat(64), sizeBytes: 10, contentType: "video/mp4" };
const REGISTERED = {
  status: "registered",
  assetId: "as1",
  fileUrl: "https://cdn/out.mp4",
  kind: "video",
  coverUrl: null,
  width: 640,
  height: 360,
  durationSeconds: 2,
  mimeType: "video/mp4",
  sizeBytes: 10,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.steps = [{ id: "s1", status: "pending", output: {} }];
  h.ensureSteps.mockImplementation(async () => h.steps);
  h.recordInline.mockImplementation(async (_id: string, output: Record<string, unknown>) => {
    h.steps[0]!.output = { ...h.steps[0]!.output, ...output };
  });
  h.openContainerOutputs.mockResolvedValue([OUT]);
  h.applyIngestReport.mockResolvedValue(REGISTERED);
});

describe("runContainerJob", () => {
  it("submits a job its class does not hold, files the output and charges the measured usage", async () => {
    h.readMiniToolJob.mockResolvedValueOnce(null).mockResolvedValueOnce({ state: "done", outputs: [MEASURED], usage: USAGE });
    h.submitMiniToolJob.mockResolvedValueOnce({ state: "starting" });

    const [result, credits] = await runContainerJob(CUT, "cut", INPUT);

    expect(h.submitMiniToolJob.mock.calls[0]![2]).toMatchObject({
      jobId: "task:t1",
      containerClass: "Std1",
      op: "cut",
      input: { storageKey: "v/src.mp4" },
      outputs: [OUT],
    });
    expect(result).toMatchObject({ outputs: [{ url: "https://cdn/out.mp4", duration_seconds: 2 }] });
    const usd = 10 * (4 * 0.0000025 + 8 * 0.00000007) + 4 * 0.00002;
    expect(credits).toBeCloseTo(usd * 100 * 2, 10);
    expect(h.recordServiceCall).toHaveBeenCalledWith(
      expect.objectContaining({ source: "container", costSource: "computed", costUsd: expect.closeTo(usd, 10) }),
    );
    expect(h.markDone).toHaveBeenCalledWith("s1", { state: "done" });
  });

  it("reads the job a previous attempt opened, without opening new outputs or submitting again", async () => {
    h.steps[0]!.output = { jobId: "task:t1", containerClass: "Std1", deadlineAt: Date.now() + 60_000, outputs: [OUT] };
    h.readMiniToolJob.mockResolvedValueOnce({ state: "done", outputs: [MEASURED], usage: USAGE });

    await runContainerJob(CUT, "cut", INPUT);

    expect(h.openContainerOutputs).not.toHaveBeenCalled();
    expect(h.submitMiniToolJob).not.toHaveBeenCalled();
  });

  it("submits again on the next poll when the container could not start", async () => {
    h.readMiniToolJob
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ state: "done", outputs: [MEASURED], usage: USAGE });
    h.submitMiniToolJob.mockRejectedValueOnce(new UploadHttpError(503, null)).mockResolvedValueOnce({ state: "starting" });

    await runContainerJob(CUT, "cut", INPUT);

    expect(h.submitMiniToolJob).toHaveBeenCalledTimes(2);
  });

  it("charges nothing for a failed job, and still writes its usage row", async () => {
    h.readMiniToolJob.mockResolvedValueOnce({ state: "failed", reason: "tool_failed", usage: USAGE });

    await expect(runContainerJob(CUT, "cut", INPUT)).rejects.toBeInstanceOf(ContainerJobFailed);
    expect(h.recordServiceCall).toHaveBeenCalledTimes(1);
    expect(h.markFailed).toHaveBeenCalledWith("s1", "tool_failed");
  });

  // §8.3: a cause the job names, such as a silent source, reaches the task row.
  it("fails with the cause the job named", async () => {
    h.readMiniToolJob.mockResolvedValueOnce({ state: "failed", reason: "no_audio_track", usage: USAGE });

    await expect(runContainerJob(CUT, "cut", INPUT)).rejects.toMatchObject({ reason: "no_audio_track" });
    expect(h.markFailed).toHaveBeenCalledWith("s1", "no_audio_track");
  });

  it("fails with the report handler's reason when an output is refused", async () => {
    h.readMiniToolJob.mockResolvedValueOnce({ state: "done", outputs: [MEASURED], usage: USAGE });
    h.applyIngestReport.mockResolvedValueOnce({ status: "rejected", reason: "unsupported_type" });

    await expect(runContainerJob(CUT, "cut", INPUT)).rejects.toMatchObject({ reason: "unsupported_type" });
    expect(h.markDone).not.toHaveBeenCalled();
  });

  it("fails as the tool's failure when the deadline passes with the job still running", async () => {
    h.steps[0]!.output = { jobId: "task:t1", containerClass: "Std1", deadlineAt: Date.now() - 10_000, outputs: [OUT] };

    await expect(runContainerJob(CUT, "cut", INPUT)).rejects.toMatchObject({ reason: "tool_failed" });
  });
});
