// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Who pays a container job is read from what admission froze (inner#1306 test plan §67.2 A03, §67.3 W02, W03; frames-split
 * design §5.5 「配置」行, §10.8 「计费」行, §10.12 run-video-tool.ts and run-container-analysis.ts rows).
 *
 * Admission freezes `chargeTo` (`platform` for a tool or analysis kind in the shared platform-funded set, else `user`) into
 * the execution plan (`storedPlanSchema`) and into the analysis's frozen parameters (`miniToolFrozenAnalysisSchema`). The
 * runners never decide it again: `run-video-tool.ts` and `run-container-analysis.ts` open every job's consumption with the
 * frozen value, so a later change of the set never reaches an admitted run.
 *
 * Only the job boundaries (`advanceStagedMiniToolPlanJob`, `advanceRegisteredMiniToolPlanJob`), the step store and the request schema are replaced: the
 * stored step already carries its request, so no recipe or grant is built, and the call that opens the job's consumption
 * is observed as it is made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as domainModule from "@breatic/domain";
import type * as sharedModule from "@breatic/shared";
import type { AcceptedMiniToolExecution, miniToolAnalysisService, OpenMiniToolPlanJobInput } from "@breatic/domain";
import type { MiniToolPlanJobRequest } from "@breatic/shared";
import { videoContainerJobId } from "@breatic/shared/mini-tools";
import { StillRunning } from "@worker/handlers/still-running.js";
import { advanceAnalysisJob } from "../run-container-analysis.js";
import { runMiniToolVideoTool } from "../run-video-tool.js";

const h = vi.hoisted(() => ({ list: vi.fn(), advance: vi.fn() }));
vi.mock("@breatic/domain", async (original) => {
  const actual = await original<typeof domainModule>();
  return { ...actual, upstreamStepRepo: { ...actual.upstreamStepRepo, listSteps: h.list } };
});
// The stored request is the job's own; its recipe is not what this file checks, so any stored object is taken as it is.
vi.mock("@breatic/shared", async (original) => ({ ...await original<typeof sharedModule>(),
  miniToolPlanJobRequestSchema: z.custom<MiniToolPlanJobRequest>((value) => typeof value === "object" && value !== null) }));
vi.mock("@worker/handlers/mini-tool/registered-plan-job.js", () => ({ advanceRegisteredMiniToolPlanJob: h.advance, advanceStagedMiniToolPlanJob: h.advance }));

const TASK = "50000000-0000-4000-8000-000000000011";
const PROJECT = "10000000-0000-4000-8000-000000000011";
const SPACE = "20000000-0000-4000-8000-000000000011";
const USER = "60000000-0000-4000-8000-000000000011";
const SOURCE = "80000000-0000-4000-8000-000000000011";
const DEADLINE = Date.now() + 3_600_000;

type Step = Awaited<ReturnType<typeof domainModule.upstreamStepRepo.listSteps>>[number];

/**
 * A stored container step whose request is already persisted.
 * @param request - The stored request.
 * @param endpoint - The container class.
 * @returns The step.
 */
function storedStep(request: Record<string, unknown>, endpoint: string): Step {
  return { id: "70000000-0000-4000-8000-000000000011", taskId: TASK, position: 0, kind: "container_job", endpoint, itemIndex: 0,
    output: { miniToolPlanJob: request } } as unknown as Step;
}

/**
 * A frozen extract-frames or split plan with one output in one batch and the given frozen payer.
 * @param tool - The tool.
 * @param chargeTo - The payer admission froze.
 * @returns The plan.
 */
function plan(tool: "video.extract-frames" | "video.split", chargeTo: "platform" | "user"): AcceptedMiniToolExecution {
  return { schemaVersion: 1, tool, taskId: TASK, projectId: PROJECT, spaceId: SPACE, sourceKey: "video/source.mp4", chargeTo,
    presentationRef: { source: { toolInputId: "a".repeat(64), planSha256: "b".repeat(64) } },
    outputs: [{ outputIndex: 0, nodeId: "40000000-0000-4000-8000-000000000011", recipe: tool === "video.split" ? { kind: "segment", range: { start: 0, end: 48 } } : { kind: "frame", frameIndex: 0 } }],
    layout: { batches: [[0]], encodes: [] },
    container: { containerClass: "MiniToolContainerStd4", chunkRetries: 0, encode: { crf: 18, preset: "medium" } } } as unknown as AcceptedMiniToolExecution;
}

/**
 * An accepted analysis of a kind with the given frozen payer.
 * @param kind - The analysis kind.
 * @param chargeTo - The payer admission froze.
 * @returns The execution.
 */
function analysis(kind: "scene_cuts", chargeTo: "platform" | "user"): miniToolAnalysisService.MiniToolAnalysisExecution {
  return { context: { taskId: TASK, userId: USER, projectId: PROJECT, spaceId: SPACE, hostNodeId: "50000000-0000-4000-8000-000000000012" },
    record: { kind, binding: { assetId: SOURCE } },
    params: { sourceKey: "video/source.mp4", credits: 0, requestFingerprint: "c".repeat(64), analysis: { kind, chargeTo } } } as unknown as miniToolAnalysisService.MiniToolAnalysisExecution;
}

/**
 * The payer of the one job the runner opened.
 * @returns It.
 */
function chargedTo(): unknown {
  expect(h.advance).toHaveBeenCalledTimes(1);
  return (h.advance.mock.calls[0]![0] as OpenMiniToolPlanJobInput).chargeTo;
}

afterEach(() => { vi.clearAllMocks(); });

describe("the extract-frames and split runners open each job with the frozen payer (§67.3 W02, W03)", () => {
  beforeEach(() => {
    const jobId = videoContainerJobId({ kind: "run-batch", taskId: TASK, batch: 0, attempt: 1 });
    h.list.mockResolvedValue([storedStep({ jobId, containerClass: "MiniToolContainerStd4" }, "MiniToolContainerStd4")]);
    h.advance.mockRejectedValue(new StillRunning(Date.now() + 5000));
  });

  it("W02: an extract-frames run frozen as platform-funded opens its batch job with chargeTo platform", async () => {
    const pickup = await runMiniToolVideoTool(plan("video.extract-frames", "platform"), USER, DEADLINE);
    expect(pickup.waiting).toBe(true);
    expect(chargedTo()).toBe("platform");
  });

  it("W03: a split run frozen as user-paid keeps chargeTo user", async () => {
    await runMiniToolVideoTool(plan("video.split", "user"), USER, DEADLINE);
    expect(chargedTo()).toBe("user");
  });

  it("W02: the payer is the frozen one, not one the runner derives from the tool (an extract-frames run frozen as user-paid)", async () => {
    await runMiniToolVideoTool(plan("video.extract-frames", "user"), USER, DEADLINE);
    expect(chargedTo()).toBe("user");
  });
});

describe("the analysis runner opens each job with the payer frozen in the analysis (§67.2 A03)", () => {
  beforeEach(() => {
    h.list.mockResolvedValue([storedStep({ jobId: `task:${TASK}/chunk:0`, containerClass: "MiniToolContainerStd4" }, "MiniToolContainerStd4")]);
    h.advance.mockImplementation(async (input: OpenMiniToolPlanJobInput) => ({ request: input.request, report: { schemaVersion: 2, state: "done", outputs: [], usage: { wallMs: 1, cpuUsec: 1 } }, assets: [] }));
  });

  it("A03: a scene_cuts analysis frozen as user-paid opens its job with chargeTo user", async () => {
    await advanceAnalysisJob(analysis("scene_cuts", "user"), DEADLINE, 0, async () => []);
    expect(chargedTo()).toBe("user");
  });

  it("A03: a scene_cuts analysis frozen as platform-funded opens its job with chargeTo platform", async () => {
    await advanceAnalysisJob(analysis("scene_cuts", "platform"), DEADLINE, 0, async () => []);
    expect(chargedTo()).toBe("platform");
  });
});
