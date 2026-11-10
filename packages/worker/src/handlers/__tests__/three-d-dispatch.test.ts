// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A 3D generation runs on the catalog lane and settles the 3D Space's own
 * task row (inner#1691, design sections 2.2 and 5).
 *
 * The job carries no target node: the row it settles is the Space-level
 * generation row the submit route opened, named by `sceneRowId`. Where a
 * canvas run writes its nodes, this run settles that row through
 * `sceneTaskService.settleById` and tells the Space's members to
 * refresh their task list. The row holds the registered asset, so the asset
 * id travels on the persisted output and back out of the stored result when a
 * billed job is delivered again.
 *
 * No real Redis / DB — everything is mocked.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import type { StoredAsset } from "@breatic/domain";

const h = vi.hoisted(() => {
  /** Stand-in for the real class, matched by `instanceof` in the dispatcher. */
  class StillRunning extends Error {
    constructor(readonly resumeAt: number) {
      super("still running");
    }
  }
  return {
    StillRunning,
    runCatalogTask: vi.fn(),
    taskDeadline: vi.fn(),
    markFailed: vi.fn(),
    moveToDelayed: vi.fn(),
    getByIdInternal: vi.fn(),
    recordProviderResult: vi.fn(),
    resolveRegisteredProjectMedia: vi.fn<(_projectId: string, url: string) => Promise<StoredAsset>>(),
    markCompletedAndBill: vi.fn(),
    markRunning: vi.fn(),
    settleTaskForNode: vi.fn(),
    updateData: vi.fn(),
    upsertGenerationSucceeded: vi.fn(),
    insertGenerationFailedIfAbsent: vi.fn(),
    settleCharge: vi.fn(),
    settleSceneRowById: vi.fn(),
    publishSpaceTasksChanged: vi.fn(async (_projectId: string, _spaceId: string) => undefined),
  };
});

vi.mock("@worker/providers/still-running.js", () => ({
  StillRunning: h.StillRunning,
}));
vi.mock("@worker/handlers/task-deadline.js", () => ({ taskDeadline: h.taskDeadline }));
vi.mock("@worker/handlers/container/run-container-job.js", () => ({
  ContainerJobFailed: class extends Error {},
  runContainerJob: vi.fn(),
}));
vi.mock("@worker/providers/run-steps.js", () => ({ runCatalogTask: h.runCatalogTask }));
vi.mock("@worker/services/project-media.service.js", () => ({
  resolveRegisteredProjectMedia: h.resolveRegisteredProjectMedia,
}));
vi.mock("@worker/providers/generate.js", () => ({
  validateModelParams: (_modality: string, model: string, params: Record<string, unknown>) => [model, params],
}));
vi.mock("@worker/handlers/step-deps.js", () => ({ stepDepsFor: () => ({}) }));
vi.mock("@breatic/core", () => ({
  runWithConsent: (_consent: unknown, fn: () => unknown) => fn(),
  reportCollaboratorFirstAction: vi.fn(async () => undefined),
  serverAnalyticsWanted: vi.fn(() => false),
  trackServerEvent: vi.fn(),
  projectsRepo: { findOwnerStudioId: vi.fn(async () => undefined) },
  getStreamRedis: vi.fn(() => ({})),
  getWorkerConfig: vi.fn(() => ({})),
  getAgentConfig: vi.fn(() => ({})),
  projectActivitiesRepo: {
    insertGenerationFailedIfAbsent: h.insertGenerationFailedIfAbsent,
    upsertGenerationSucceeded: h.upsertGenerationSucceeded,
  },
  publishActivityNew: vi.fn(),
  publishSpaceTasksChanged: h.publishSpaceTasksChanged,
  getStorageAdapter: vi.fn(async () => ({ keyFromUrl: () => "three_d/out.glb" })),
  getRawEnvVar: vi.fn(),
  getUnderstandConfig: vi.fn(() => ({})),
  storageKey: vi.fn(),
  env: {},
  NotFoundError: class extends Error {},
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@breatic/domain", async () => ({
  failureOutcome: (await import("@domain/node-task/failure-outcome.js")).failureOutcome,
  buildAgentConfig: vi.fn(),
  getModel: vi.fn(),
  generateTextRetry: vi.fn(),
  taskService: {
    markFailed: h.markFailed,
    markRunning: h.markRunning,
    getByIdInternal: h.getByIdInternal,
    recordProviderResult: h.recordProviderResult,
    recordProviderTaskId: vi.fn(),
    markCompletedAndBill: h.markCompletedAndBill,
  },
  upstreamStepRepo: { failOpenSteps: vi.fn() },
  assetService: { resolveOwnerStudioId: vi.fn(async () => "studio-1") },
  creditLotService: {
    settleCharge: h.settleCharge,
    pendingChargeRequestId: vi.fn(async () => null),
    recordSettleFailure: vi.fn(async () => undefined),
  },
  creditHoldService: { releaseHold: vi.fn(async () => undefined) },
  creditsForUsd: (usd: number) => usd,
  toChargeCredits: (await import("@domain/credit/credit-math.js")).toChargeCredits,
  resolveActiveProvider: vi.fn(),
  modelCatalog: { getModelCatalog: () => ({ image: [], video: [], audio: [], tts: [], three_d: [] }) },
  nodeHistoryService: { recordGenerationFailure: vi.fn(), recordGenerationSuccess: vi.fn() },
  settleTaskForNode: h.settleTaskForNode,
  sceneTaskService: {
    generationOutcome: (await import("@domain/node-task/scene-task.service.js")).generationOutcome,
    settleById: h.settleSceneRowById,
  },
  understandMediaAt: vi.fn(),
  readingLimitsUntil: (await import("@domain/understand/limits-until.js")).readingLimitsUntil,
  MediaUnavailable: class extends Error {},
  UnderstandRefused: class extends Error {},
  createUsageRecorder: () => ({ recordServiceCall: vi.fn(), settle: async () => 0 }),
  UNDERSTAND_PINS: {},
}));

import type { Job } from "bullmq";

import { runTask } from "@worker/handlers/dispatch.js";
import { storedAsOutput } from "@worker/handlers/persisted-output.js";

const DEADLINE = 1_800_000_000_000;
const GLB = "https://cdn/three_d/out.glb";

/** The Space-level generation row the submit route opened. */
const ROW = {
  id: "row-1",
  projectId: "proj-1",
  spaceId: "space-1",
  nodeId: null,
  kind: "generation",
  action: "generate",
  status: "running",
  startedByUserId: "user-1",
  startedAt: new Date(DEADLINE - 7_200_000),
  settledAt: null,
  budgetMs: 7_200_000,
  label: "a wooden chair",
  errorMessage: null,
  nodeHistoryId: null,
  assetId: null,
};

/**
 * A 3D generation job as the submit route queues it.
 * @param attemptsMade - Attempts already spent.
 * @returns The job.
 */
function sceneJob(attemptsMade = 0): Job {
  return {
    id: "job-1",
    attemptsMade,
    stalledCounter: 0,
    opts: { attempts: 3 },
    moveToDelayed: h.moveToDelayed,
    updateData: h.updateData,
    extendLock: async () => 1,
    data: {
      taskId: "task-1",
      taskType: "three_d",
      userId: "user-1",
      projectId: "proj-1",
      spaceId: "space-1",
      params: { prompt: "a wooden chair", texture: true, pbr: true },
      model: "tripo-h3.1-t23d",
      mode: "append",
      targetNodeIds: [],
      sceneRowId: "row-1",
    },
  } as unknown as Job;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getByIdInternal.mockResolvedValue({
    status: "running",
    startedAt: new Date(),
    billedAt: null,
    providerResultUrl: null,
    providerTaskId: null,
  });
  h.markRunning.mockResolvedValue(new Date());
  h.taskDeadline.mockResolvedValue(DEADLINE);
  h.markCompletedAndBill.mockResolvedValue(true);
  h.runCatalogTask.mockResolvedValue({ outputs: [{ url: GLB }], cost: 0.24, model: "tripo-h3.1-t23d" });
  h.resolveRegisteredProjectMedia.mockImplementation(async (_projectId, fileUrl) => ({
    assetId: "asset-glb",
    fileUrl,
    kind: "three_d",
    coverUrl: null,
    width: null,
    height: null,
    durationSeconds: null,
    mimeType: "model/gltf-binary",
    sizeBytes: 2048,
  }));
  h.settleCharge.mockResolvedValue({ billed: true, charged: "0.240000", shortfall: "0.000000", studioId: "studio-1", lotIds: [] });
  h.settleSceneRowById.mockResolvedValue({ row: ROW, applied: true, assetWritten: true });
});

describe("a 3D generation on the catalog lane (inner#1691)", () => {
  it("runs through runCatalogTask under the three_d modality", async () => {
    await runTask(sceneJob(), "lock-token");

    expect(h.runCatalogTask).toHaveBeenCalledTimes(1);
    expect(h.runCatalogTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taskId: "task-1", studioId: "studio-1", deadlineAt: DEADLINE }),
      "three_d",
      "a wooden chair",
      "tripo-h3.1-t23d",
      { texture: true, pbr: true },
      1,
    );
  });

  it("settles the Space row it names as done with the registered model, and tells the Space to refresh", async () => {
    const result = await runTask(sceneJob(), "lock-token");

    expect(result).not.toHaveProperty("failed");
    expect(h.settleSceneRowById).toHaveBeenCalledExactlyOnceWith("row-1", { outcome: "done", assetId: "asset-glb" });
    expect(h.publishSpaceTasksChanged).toHaveBeenCalledWith("proj-1", "space-1");
    // A Space row is not a node: nothing is settled on the canvas.
    expect(h.settleTaskForNode).not.toHaveBeenCalled();
  });

  it("stores the asset id on the persisted output the task row keeps", async () => {
    await runTask(sceneJob(), "lock-token");

    const stored = h.markCompletedAndBill.mock.calls[0]![1] as { outputs: Array<Record<string, unknown>> };
    expect(stored.outputs).toHaveLength(1);
    expect(stored.outputs[0]).toMatchObject({ url: GLB, asset_id: "asset-glb" });
  });

  it("settles the row as failed with the stored cause once the run is over, and not while a retry is to come", async () => {
    // A retryable attempt: the queue runs it again, so the row stays running.
    h.runCatalogTask.mockRejectedValueOnce(new Error("upstream 502"));
    await expect(runTask(sceneJob(0), "lock-token")).rejects.toThrow("upstream 502");
    expect(h.settleSceneRowById).not.toHaveBeenCalled();

    // Storing the result fails after the vendor returned: the run is over.
    h.resolveRegisteredProjectMedia.mockRejectedValueOnce(new Error("ledger down"));
    await expect(runTask(sceneJob(1), "lock-token")).resolves.toEqual({ failed: true, reason: "persist_failed" });

    expect(h.settleSceneRowById).toHaveBeenCalledExactlyOnceWith("row-1", { outcome: "failed", errorMessage: "internal" });
    expect(h.publishSpaceTasksChanged).toHaveBeenCalledWith("proj-1", "space-1");
    expect(h.markCompletedAndBill).not.toHaveBeenCalled();
  });

  it("settles the row from the stored output when a billed job is delivered again", async () => {
    h.getByIdInternal.mockResolvedValue({
      billedAt: new Date(),
      billedCredits: 0.24,
      result: { model: "tripo-h3.1-t23d", outputs: [{ url: GLB, asset_id: "asset-glb" }] },
    });

    await runTask(sceneJob(), "lock-token");

    expect(h.runCatalogTask).not.toHaveBeenCalled();
    expect(h.settleSceneRowById).toHaveBeenCalledExactlyOnceWith("row-1", { outcome: "done", assetId: "asset-glb" });
    expect(h.publishSpaceTasksChanged).toHaveBeenCalledWith("proj-1", "space-1");
  });
});

describe("the persisted output of a registered file (inner#1691)", () => {
  it("carries the asset id the file registered as", () => {
    const stored: StoredAsset = {
      assetId: "asset-1",
      fileUrl: GLB,
      kind: "three_d",
      coverUrl: null,
      width: null,
      height: null,
      durationSeconds: null,
      mimeType: "model/gltf-binary",
      sizeBytes: 2048,
    };

    expect(storedAsOutput(stored)).toEqual({
      url: GLB,
      asset_id: "asset-1",
      width: null,
      height: null,
      duration_seconds: null,
      mime_type: "model/gltf-binary",
      size_bytes: 2048,
    });
  });
});
