// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as domainModule from "@breatic/domain";
import type * as coreModule from "@breatic/core";
import type { MiniToolPlanJobRequest, StudioAssetEntity } from "@breatic/shared";
import type { MiniToolStepResultParser, RecordMiniToolStepResultInput } from "@breatic/domain";

const h = vi.hoisted(() => ({ open: vi.fn(), list: vi.fn(), advance: vi.fn(), record: vi.fn(), inline: vi.fn(), register: vi.fn(), find: vi.fn(), error: vi.fn() }));
vi.mock("@breatic/domain", async (original) => {
  const actual = await original<typeof domainModule>();
  return { ...actual, openMiniToolPlanJob: h.open, recordMiniToolStepResult: h.record,
    upstreamStepRepo: { ...actual.upstreamStepRepo, listSteps: h.list, recordInline: h.inline },
    ingestReportService: { ...actual.ingestReportService, applyIngestReport: h.register },
    assetRepo: { ...actual.assetRepo, findById: h.find } };
});
vi.mock("@breatic/core", async (original) => ({ ...await original<typeof coreModule>(), logger: { error: h.error } }));
vi.mock("@worker/handlers/mini-tool/advance-plan-job.js", () => ({ advanceMiniToolPlanJob: h.advance }));

import { advanceRegisteredMiniToolPlanJob } from "../registered-plan-job.js";
import { StillRunning } from "@worker/handlers/still-running.js";

const taskId = "10000000-0000-4000-8000-000000000001";
const stepId = "20000000-0000-4000-8000-000000000001";
const inputId = "30000000-0000-4000-8000-000000000001";
const plan: MiniToolPlanJobRequest = {
  schemaVersion: 2, jobId: "original-analysis/chunk:0", containerClass: "OriginalClass", deadlineAt: 1792927200000,
  limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 },
  inputs: [{ inputId, storageKey: "original/video.mp4" }],
  // §93 D5 (frames-split design §7.17 scene_cuts row 「去掉inspect_video步骤」, people anchor row): the text outputs are people
  // detections on a grid frame, not the removed inspect_video recipe.
  outputs: [8, 9].map((outputIndex) => ({ outputIndex, storageKey: `declared/${outputIndex}.txt`, contentType: "text/plain", recipe: { kind: "people", inputId,
    grid: { fps: { numerator: 25, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 96, realFrameCount: 96 }, source: { kind: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1.92, allKeyframes: false } }, frameIndex: 0,
    target: { width: 32, height: 18, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" },
    profile: { id: "opencv-yunet-2023mar", version: "2023mar", weightsHash: null, params: {} } } })),
};
const input = { taskId, stepId, chunkIndex: 0, chargeTo: "platform", request: plan } as const;
const identity = { kind: "container", containerClass: plan.containerClass, jobId: plan.jobId, chunkIndex: 0 } as const;
const outputs = [9, 8].map((outputIndex) => ({ outputIndex, storageKey: `declared/${outputIndex}.txt`, sha256: String(outputIndex).repeat(64),
  sizeBytes: 128, contentType: "text/plain", width: null, height: null, durationSeconds: null, cover: null, upright: null }));
const done = { schemaVersion: 2, state: "done", outputs, usage: { wallMs: 1250, cpuUsec: 123456 } } as const;
const failed = { schemaVersion: 2, state: "failed", outputs: outputs.slice(1), reason: "tool_failed", usage: { wallMs: 999, cpuUsec: null } } as const;
const consumption = { schemaVersion: 1, consumptionKey: "a".repeat(64), identity, state: "pending", creditMultiplier: 2, chargeTo: "platform",
  costUsd: null, costSource: null, raw: null, credits: null, containerPricing: { configVersion: "original", size: { vcpu: 1, memory_gib: 1, disk_gb: 4 },
    prices: { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.0000025, disk_gb_second_usd: 0.00000007 } } };
const baseState = { schemaVersion: 1, scope: { taskId, stepId, kind: "container_job", endpoint: plan.containerClass, itemIndex: 0 }, deadlineAt: plan.deadlineAt,
  requestBody: null, requestFingerprint: null, chargeTo: null, creditMultiplier: null, attempts: [], result: null, error: null, conflicts: [] };
const rows = [8, 9].map((outputIndex): { outputIndex: number; asset: StudioAssetEntity } => ({ outputIndex, asset: {
  id: `40000000-0000-4000-8000-00000000000${outputIndex}`, studioId: "50000000-0000-4000-8000-000000000001",
  contentHash: String(outputIndex).repeat(64), storageKey: `canonical-winner/${outputIndex}.txt`, fileUrl: `https://assets.test.invalid/canonical-winner/${outputIndex}.txt`,
  sizeBytes: 128, mimeType: "text/plain", kind: "document", source: "upload", producedByUserId: "60000000-0000-4000-8000-000000000001",
  generationTaskId: null, width: null, height: null, durationSeconds: null, createdAt: new Date("2026-10-24T00:00:00Z"), deletedAt: null,
} }));
let step: Awaited<ReturnType<typeof domainModule.upstreamStepRepo.listSteps>>[number];

beforeEach(() => {
  vi.resetAllMocks();
  step = { id: stepId, position: 0, kind: "container_job", endpoint: plan.containerClass, itemIndex: 0,
    predictionId: null, status: "pending", inlineCostUsd: 0, output: { miniToolPlanJob: structuredClone(plan), miniToolConsumption: structuredClone(consumption), sibling: "preserved" } };
  h.open.mockResolvedValue({ request: plan, consumption }); h.list.mockImplementation(async () => [step]); h.advance.mockResolvedValue(done);
  h.record.mockImplementation(async (value: RecordMiniToolStepResultInput, parser: MiniToolStepResultParser) => {
    const result = parser.parse(value.result);
    step = { ...step, status: value.outcome, output: { ...step.output, miniToolStep: { ...baseState,
      result: { outcome: value.outcome, result, error: value.error ?? null }, error: value.error ?? null } } };
    return step;
  });
  h.inline.mockImplementation(async (_id: string, patch: Record<string, unknown>) => { step.output = { ...step.output, ...patch }; });
  h.register.mockImplementation(async (measured: { storageKey: string }) => {
    const row = rows.find(({ outputIndex }) => measured.storageKey === `declared/${outputIndex}.txt`)!;
    return { status: "already_registered", assetId: row.asset.id, fileUrl: row.asset.fileUrl, kind: row.asset.kind, ownRow: false,
      coverUrl: null, width: null, height: null, durationSeconds: null, mimeType: row.asset.mimeType, sizeBytes: row.asset.sizeBytes };
  });
  h.find.mockImplementation(async (id: string) => rows.find(({ asset }) => asset.id === id)?.asset ?? null);
});

describe("original planned job registration", () => {
  it("persists the exact terminal report and usage before registering indexed canonical outputs", async () => {
    expect(await advanceRegisteredMiniToolPlanJob(input)).toEqual({ request: plan, report: done, assets: rows });
    expect(h.advance).toHaveBeenCalledExactlyOnceWith(plan);
    expect(h.record).toHaveBeenCalledWith({ taskId, stepId, identity, outcome: "done", result: done }, expect.objectContaining({ kind: "container_job" }));
    expect(h.record.mock.invocationCallOrder[0]).toBeLessThan(h.register.mock.invocationCallOrder[0]!);
    expect(step.output.miniToolConsumption).toEqual(consumption); expect(step.output.sibling).toBe("preserved");
    expect(h.inline.mock.calls.map((call) => call[1])).toEqual([{ "miniToolAsset:8": rows[0]!.asset.id }, { "miniToolAsset:9": rows[1]!.asset.id }]);
  });

  it("uses the first frozen request even when a caller allocates a changed candidate", async () => {
    const candidate = { ...input, request: { ...plan, deadlineAt: plan.deadlineAt + 5000, outputs: plan.outputs.map((output) => ({ ...output, storageKey: `unused/${output.outputIndex}.txt` })) } };
    expect(await advanceRegisteredMiniToolPlanJob(candidate)).toEqual({ request: plan, report: done, assets: rows });
    expect(h.advance).toHaveBeenCalledExactlyOnceWith(plan);
  });

  it.each([failed, { ...failed, usage: null }])("registers only a failed job's actual subset while preserving its complete report", async (report) => {
    h.advance.mockResolvedValue(report);
    expect(await advanceRegisteredMiniToolPlanJob(input)).toEqual({ request: plan, report, assets: rows.slice(0, 1) });
    expect(h.register).toHaveBeenCalledTimes(1); expect(step.status).toBe("failed");
    expect(h.record.mock.calls[0]?.[0]).toEqual({ taskId, stepId, identity, outcome: "failed", result: report, error: { code: "tool_failed" } });
    expect(step.output.miniToolConsumption).toEqual(consumption);
  });

  it("reuses the original report and cached registrations on re-entry", async () => {
    await advanceRegisteredMiniToolPlanJob(input);
    h.advance.mockClear(); h.register.mockClear(); h.record.mockClear();
    expect(await advanceRegisteredMiniToolPlanJob(input)).toEqual({ request: plan, report: done, assets: rows });
    expect(h.advance).not.toHaveBeenCalled(); expect(h.record).not.toHaveBeenCalled(); expect(h.register).not.toHaveBeenCalled();
  });

  it("reuses a failed report's registered subset without changing its failed state", async () => {
    h.advance.mockResolvedValue(failed);
    await advanceRegisteredMiniToolPlanJob(input); h.advance.mockClear(); h.register.mockClear();
    expect(await advanceRegisteredMiniToolPlanJob(input)).toEqual({ request: plan, report: failed, assets: rows.slice(0, 1) });
    expect(step.status).toBe("failed"); expect(h.advance).not.toHaveBeenCalled(); expect(h.register).not.toHaveBeenCalled();
  });

  it("continues registration after an interruption using the already persisted terminal report", async () => {
    const error = new Error("registration unavailable"); h.register.mockRejectedValueOnce(error);
    await expect(advanceRegisteredMiniToolPlanJob(input)).rejects.toBe(error);
    h.advance.mockClear();
    expect(await advanceRegisteredMiniToolPlanJob(input)).toEqual({ request: plan, report: done, assets: rows });
    expect(h.advance).not.toHaveBeenCalled(); expect(h.record).toHaveBeenCalledTimes(1);
  });

  it("preserves the already registered sibling when a later registration fails", async () => {
    const normal = h.register.getMockImplementation()!;
    h.register.mockImplementation(async (measured) => { if (measured.storageKey === "declared/9.txt") throw new Error("second registration unavailable"); return normal(measured); });
    await expect(advanceRegisteredMiniToolPlanJob(input)).rejects.toThrow("second registration unavailable");
    expect(step.output["miniToolAsset:8"]).toBe(rows[0]!.asset.id);
    h.register.mockClear(); h.register.mockImplementation(normal); h.advance.mockClear();
    expect(await advanceRegisteredMiniToolPlanJob(input)).toEqual({ request: plan, report: done, assets: rows });
    expect(h.register).toHaveBeenCalledTimes(1); expect(h.register.mock.calls[0]?.[0]).toMatchObject({ storageKey: "declared/9.txt" });
    expect(h.advance).not.toHaveBeenCalled();
  });

  it.each([
    { ...done, outputs: outputs.slice(0, 1) }, { ...done, outputs: [outputs[0], outputs[0]] },
    { ...done, outputs: outputs.map((output) => ({ ...output, storageKey: "foreign/key" })) },
    { ...done, outputs: outputs.map((output) => ({ ...output, cover: { storageKey: "foreign/cover.png", sha256: "c".repeat(64), sizeBytes: 20, contentType: "image/png", width: 1, height: 1 } })) },
  ])("refuses a report that differs from the original output declaration", async (report) => {
    h.advance.mockResolvedValue(report);
    await expect(advanceRegisteredMiniToolPlanJob(input)).rejects.toThrow();
    expect(h.record).not.toHaveBeenCalled(); expect(h.register).not.toHaveBeenCalled();
  });

  it.each([{ status: "rejected", reason: "over_cap" }, { status: "stale" }, { status: "voided" }])("preserves a $status registration as failure", async (outcome) => {
    h.register.mockResolvedValue(outcome);
    await expect(advanceRegisteredMiniToolPlanJob(input)).rejects.toThrow("Planned output registration failed");
    expect(step.output).toMatchObject({ miniToolStep: { result: { result: done } }, miniToolConsumption: consumption });
    expect(h.inline).not.toHaveBeenCalled();
  });

  it.each([null, { ...rows[0]!.asset, deletedAt: new Date("2026-10-25T00:00:00Z") }])("refuses a registered output whose actual row is unavailable", async (row) => {
    h.find.mockResolvedValue(row);
    await expect(advanceRegisteredMiniToolPlanJob(input)).rejects.toThrow("Registered planned output is unavailable");
  });

  it("preserves a pending advance without registering or inventing a terminal report", async () => {
    const waiting = new StillRunning(1792920000000); h.advance.mockRejectedValue(waiting);
    await expect(advanceRegisteredMiniToolPlanJob(input)).rejects.toBe(waiting);
    expect(h.record).not.toHaveBeenCalled(); expect(h.register).not.toHaveBeenCalled();
  });

  it.each(["starting", "running"])("refuses %s as a stored terminal report", async (state) => {
    h.advance.mockResolvedValue({ schemaVersion: 2, state });
    await expect(advanceRegisteredMiniToolPlanJob(input)).rejects.toThrow();
    expect(h.record).not.toHaveBeenCalled(); expect(h.register).not.toHaveBeenCalled();
  });

  it("stops registration when report persistence fails", async () => {
    const error = new Error("report storage unavailable"); h.record.mockRejectedValue(error);
    await expect(advanceRegisteredMiniToolPlanJob(input)).rejects.toBe(error);
    expect(h.register).not.toHaveBeenCalled();
  });

  it("reuses the persisted report when storing a successful registration is interrupted", async () => {
    const error = new Error("artifact progress unavailable"); h.inline.mockRejectedValueOnce(error);
    await expect(advanceRegisteredMiniToolPlanJob(input)).rejects.toBe(error); h.advance.mockClear();
    expect(await advanceRegisteredMiniToolPlanJob(input)).toEqual({ request: plan, report: done, assets: rows });
    expect(h.advance).not.toHaveBeenCalled(); expect(h.record).toHaveBeenCalledTimes(1);
  });

  it("stops when the original owned step is no longer readable", async () => {
    h.list.mockResolvedValue([]);
    await expect(advanceRegisteredMiniToolPlanJob(input)).rejects.toThrow("Planned job lost its owning step");
    expect(h.advance).not.toHaveBeenCalled(); expect(h.register).not.toHaveBeenCalled();
  });

  it("refuses a malformed cached asset identity before using it", async () => {
    await advanceRegisteredMiniToolPlanJob(input);
    step.output["miniToolAsset:8"] = "invalid-asset-id";
    h.find.mockClear(); h.register.mockClear();
    await expect(advanceRegisteredMiniToolPlanJob(input)).rejects.toThrow();
    expect(h.find).not.toHaveBeenCalled(); expect(h.register).not.toHaveBeenCalled();
  });

  it("logs side effect failure while keeping the canonical registration", async () => {
    const normal = h.register.getMockImplementation()!;
    h.register.mockImplementation(async (measured) => ({ ...await normal(measured), countsPublishFailed: true }));
    expect(await advanceRegisteredMiniToolPlanJob(input)).toEqual({ request: plan, report: done, assets: rows });
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ taskId }), "node_task_counts_publish_failed");
  });
});

// §93 D5-10 (design §7.15 块对象「拼接提交后」释放; prepare-model-input.ts PP02): a split stitch is registered through this
// function and names the chunk outputs it consumed, which are retired with its done result, never before. This round's
// choice of the option (may be vetoed): a second argument `{ retire }`.
describe("chunk outputs retired with a done stitch (§93 D5-10)", () => {
  const CHUNKS = ["video/source.mp4.work/T:out:0:enc:0:a1", "video/source.mp4.work/T:out:0:enc:1:a1"];
  type WithRetire = (value: typeof input, options: { retire: readonly string[] }) => ReturnType<typeof advanceRegisteredMiniToolPlanJob>;

  it("RP01 a done stitch records its result together with the retirement of the consumed chunk keys", async () => {
    await (advanceRegisteredMiniToolPlanJob as unknown as WithRetire)(input, { retire: CHUNKS });
    expect(h.record).toHaveBeenCalledExactlyOnceWith({ taskId, stepId, identity, outcome: "done", result: done, presentation: { retire: CHUNKS } },
      expect.objectContaining({ kind: "container_job" }));
  });

  it("RP02 a failed stitch keeps the chunks for its next attempt", async () => {
    h.advance.mockResolvedValue(failed);
    await (advanceRegisteredMiniToolPlanJob as unknown as WithRetire)(input, { retire: CHUNKS });
    const recorded = h.record.mock.calls[0]![0] as { presentation?: { retire?: string[] } };
    expect(recorded.presentation?.retire ?? []).not.toEqual(expect.arrayContaining([CHUNKS[0]]));
  });
});
