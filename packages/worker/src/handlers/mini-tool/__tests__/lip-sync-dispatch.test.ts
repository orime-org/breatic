// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A planned `video.lip-sync` pickup reaches the lip-sync runner (inner#1306 test plan §97; execution design §9.3, §9.4;
 * multi-person lip-sync DD §7.2, §7.3). `runMiniToolExecutionTask` routes frames and split to their runner and everything
 * else to the removal runner today; a lip-sync run must go to `runMiniToolLipSync(execution, userId, deadlineAt)` in
 * `run-lip-sync.ts`, never to the removal or frames runner, and its one output's result (a registered video, or the one
 * §9.4 failure reason as the failed result's `error`) is what the terminal commit carries.
 *
 * The SQL lifecycle, the step list, the deadline, the lock and the completion owner are mocked as in run-video-tool; the
 * three runners are mocked so the test sees only where the pickup went and what it committed.
 */
import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as coreModule from "@breatic/core";
import type * as domainModule from "@breatic/domain";
import type { MiniToolExecutionCompletion, MiniToolExecutionJob } from "@breatic/domain";
import { StillRunning } from "@worker/providers/still-running.js";
import { runMiniToolExecutionTask } from "../run-execution-task.js";

const h = vi.hoisted(() => ({
  start: vi.fn(), list: vi.fn(), finish: vi.fn(), progress: vi.fn(), deadline: vi.fn(), removal: vi.fn(), videoTool: vi.fn(), lipSync: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@breatic/core", async (original) => {
  const actual = await original<typeof coreModule>();
  return { ...actual, logger: h.logger as unknown as typeof actual.logger, getStreamRedis: () => ({}),
    getMiniToolsConfig: (): ReturnType<typeof actual.getMiniToolsConfig> => ({ ...actual.getMiniToolsConfig(), poll_interval_ms: 5000 }) };
});
vi.mock("@breatic/domain", async (original) => {
  const actual = await original<typeof domainModule>();
  return { ...actual,
    miniToolExecutionService: { ...actual.miniToolExecutionService, startMiniToolExecution: h.start, commitMiniToolExecutionProgress: h.progress },
    upstreamStepRepo: { ...actual.upstreamStepRepo, listSteps: h.list } };
});
vi.mock("@worker/handlers/mini-tool/execution-completion.js", async (original) => ({ ...await original<Record<string, unknown>>(), finishMiniToolExecutionAndNotify: h.finish }));
vi.mock("@worker/handlers/task-deadline.js", () => ({ taskDeadline: h.deadline }));
vi.mock("@worker/handlers/mini-tool/run-remove-background.js", () => ({ runMiniToolRemoveBackground: h.removal }));
vi.mock("@worker/handlers/mini-tool/run-video-tool.js", () => ({ runMiniToolVideoTool: h.videoTool }));
vi.mock("@worker/handlers/mini-tool/run-lip-sync.js", () => ({ runMiniToolLipSync: h.lipSync }));
vi.mock("@worker/handlers/dispatch.js", () => ({ isTerminalAttempt: () => false, verifyJobLockOwnership: async () => true }));

const TASK = "50000000-0000-4000-8000-000000000001";
const USER = "60000000-0000-4000-8000-000000000001";
const NODE = "40000000-0000-4000-8000-000000000001";
const DEADLINE = Date.now() + 3_600_000;
// The frozen lip-sync run as execution-plan.service.ts stores it; the runners are mocked, so only identity fields matter.
const EXECUTION = {
  schemaVersion: 1, tool: "video.lip-sync", taskId: TASK, projectId: "10000000-0000-4000-8000-000000000001", spaceId: "20000000-0000-4000-8000-000000000001",
  targetNodeIds: [NODE], outputs: [{ outputIndex: 0, nodeId: NODE, recipe: { kind: "lip-sync" } }], model: "sync-lipsync-3",
  binding: { assetId: "80000000-0000-4000-8000-000000000001", contentHash: "a".repeat(64), canonicalURL: "https://assets.example.test/video/source.mp4", kind: "video",
    mediaInfo: { width: 320, height: 180, duration: 3.84, mimeType: "video/mp4" } },
  sourceKey: "video/source.mp4", planFingerprint: "d".repeat(64), requestFingerprint: "c".repeat(64), credits: 40,
  generator: { backend: "wavespeed-crop", modelId: "sync-lipsync-3", schemaFingerprint: "1".repeat(64), providerSyncMode: "cut_off" },
  timeline: { duration: 2, videoDuration: 3.84, syncMode: "cut_off" }, usedRange: { start: 0, end: 2 },
  persons: [{ personId: "person-1", detectionNumber: 1, anchor: { frameIndex: 0, pts: 0 }, anchorFaceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 } }],
};
const REASON = { kind: "lipsync", shared: null, persons: [{ personId: "person-1", detectionNumber: 1, step: "faces", category: "no_face" }] };
const REGISTERED = { status: "registered", assetId: "90000000-0000-4000-8000-000000000001", canonicalURL: "https://assets.example.test/video/out.mp4", kind: "video",
  contentHash: "e".repeat(64), mimeType: "video/mp4", size: 100, width: 320, height: 180, duration: 2, cover: null };

/**
 * One planned pickup through the real entry; a waiting pickup rethrows StillRunning without a queue token.
 * @returns The completion handed to the terminal owner, or null when none was.
 */
async function pickup(): Promise<MiniToolExecutionCompletion | null> {
  const job = { id: "queue-job", data: { taskId: TASK, source: "mini_tool", executionKind: "planned" }, attemptsMade: 0, stalledCounter: 0, moveToDelayed: vi.fn() };
  try { await runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>); } catch (error) { if (!(error instanceof StillRunning)) throw error; }
  return (h.finish.mock.calls[0]?.[1] as MiniToolExecutionCompletion | undefined) ?? null;
}

beforeEach(() => {
  vi.resetAllMocks();
  const task = { id: TASK, userId: USER, projectId: EXECUTION.projectId, spaceId: EXECUTION.spaceId, createdAt: new Date(), status: "running", source: "mini_tool", mode: "append" };
  const record = { schemaVersion: 1, runId: TASK, status: "running", planFingerprint: EXECUTION.planFingerprint, resultVersion: 0, sourceBindings: [EXECUTION.binding],
    outputs: [{ ...EXECUTION.outputs[0], result: null, late: false }], usage: [], billingState: "idle", error: null };
  h.start.mockResolvedValue({ task, execution: structuredClone(EXECUTION), record });
  h.list.mockResolvedValue([]);
  h.deadline.mockResolvedValue(DEADLINE);
  h.finish.mockImplementation(async () => ({ record: { status: "completed" } }));
  h.removal.mockRejectedValue(new Error("A lip-sync run must not take the removal runner"));
  h.videoTool.mockRejectedValue(new Error("A lip-sync run must not take the frames or split runner"));
});

describe("a planned lip-sync pickup reaches the lip-sync runner (§97; execution design §9.4; DD §7.2, §7.3)", () => {
  it("LD01 runs the frozen lip-sync plan through runMiniToolLipSync with its user and task deadline, and no other runner", async () => {
    h.lipSync.mockResolvedValue({ results: new Map([[0, REGISTERED]]), waiting: false });
    await pickup();
    expect(h.lipSync).toHaveBeenCalledTimes(1);
    expect(h.lipSync).toHaveBeenCalledWith(expect.objectContaining({ tool: "video.lip-sync", taskId: TASK, persons: EXECUTION.persons }), USER, DEADLINE);
    expect(h.removal).not.toHaveBeenCalled();
    expect(h.videoTool).not.toHaveBeenCalled();
  });

  it("LD02 commits the registered output the runner returned once", async () => {
    h.lipSync.mockResolvedValue({ results: new Map([[0, REGISTERED]]), waiting: false });
    const completion = await pickup();
    expect(h.finish).toHaveBeenCalledTimes(1);
    expect(completion).toMatchObject({ planFingerprint: EXECUTION.planFingerprint, error: null, outputs: [{ outputIndex: 0, nodeId: NODE, result: REGISTERED }] });
  });

  it("LD03 commits the one §9.4 reason as the failed output's error and the run's error (CommitFail once)", async () => {
    h.lipSync.mockResolvedValue({ results: new Map([[0, { status: "failed", error: REASON }]]), waiting: false });
    const completion = await pickup();
    expect(h.finish).toHaveBeenCalledTimes(1);
    expect(completion).toMatchObject({ error: REASON, outputs: [{ outputIndex: 0, result: { status: "failed", error: REASON } }] });
  });

  it("LD04 a pickup whose steps still run waits without a terminal commit", async () => {
    h.lipSync.mockResolvedValue({ results: new Map(), waiting: true });
    expect(await pickup()).toBeNull();
    expect(h.lipSync).toHaveBeenCalledTimes(1);
    expect(h.finish).not.toHaveBeenCalled();
  });
});
