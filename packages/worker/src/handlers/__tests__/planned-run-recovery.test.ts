// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A planned run alone decides its end (frames-split design §7.19 巡检): the failed-job cleanup and the sweep both end a run
 * whose job will not pick it up again through one recovery. Past its commit point the run is completed (registered again
 * idempotently); before it, the run fails as internal. A run still pending is failed through `failTask`, since nothing
 * ever started it. The sweep lists running runs and pending runs that never waited for a slot and are older than a grace
 * window, and leaves every run whose job still waits or runs to that job.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Queue } from "bullmq";
import type * as coreModule from "@breatic/core";
import type * as domainModule from "@breatic/domain";
import type { MiniToolExecutionCompletion } from "@breatic/domain";

const h = vi.hoisted(() => ({ start: vi.fn(), finish: vi.fn(), register: vi.fn(), failTask: vi.fn(), list: vi.fn(), recover: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@breatic/core", async (original) => {
  const actual = await original<typeof coreModule>();
  return { ...actual, logger: h.logger as unknown as typeof actual.logger, getStreamRedis: () => ({}) };
});
vi.mock("@breatic/domain", async (original) => {
  const actual = await original<typeof domainModule>();
  return { ...actual,
    runningSlotService: { ...actual.runningSlotService, failTask: h.failTask },
    miniToolExecutionService: { ...actual.miniToolExecutionService, startMiniToolExecution: h.start, plannedRunsToSweep: h.list } };
});
vi.mock("@worker/handlers/mini-tool/execution-completion.js", () => ({ finishMiniToolExecutionAndNotify: h.finish }));
vi.mock("@worker/handlers/mini-tool/run-video-tool.js", () => ({ registerReportedOutputs: h.register }));

const TASK = "50000000-0000-4000-8000-000000000001";
const NODES = ["40000000-0000-4000-8000-000000000001", "40000000-0000-4000-8000-000000000002"];
const REGISTERED = (index: number): Record<string, unknown> => ({ status: "registered", assetId: `90000000-0000-4000-8000-00000000000${index}` });

/**
 * The run as the pickup entry reads it.
 * @param status - The task row's status.
 * @param commitPoint - Its commit point, if any.
 */
function runAs(status: string, commitPoint?: string): void {
  const outputs = NODES.map((nodeId, outputIndex) => ({ outputIndex, nodeId, recipe: { kind: "frame", frameIndex: outputIndex }, result: null }));
  h.start.mockResolvedValue({ task: { id: TASK, status, userId: "u" },
    execution: { planFingerprint: "f".repeat(64), outputs: outputs.map(({ result: _r, ...output }) => output) },
    record: { status, resultVersion: 0, outputs, ...(commitPoint === undefined ? {} : { commitPoint }) } });
}

/**
 * The recovery under test, loaded after the mocks.
 * @returns It.
 */
async function recovery(): Promise<(taskId: string) => Promise<void>> {
  const module = await import("@worker/handlers/mini-tool/recover-planned-run.js") as { recoverPlannedRun?: (taskId: string) => Promise<void> };
  expect(module.recoverPlannedRun, "recoverPlannedRun is exported").toBeTypeOf("function");
  return module.recoverPlannedRun!;
}

beforeEach(() => {
  vi.resetAllMocks();
  h.register.mockResolvedValue(new Map([[0, REGISTERED(0)], [1, REGISTERED(1)]]));
  h.finish.mockResolvedValue({ record: { status: "completed" } });
  h.failTask.mockResolvedValue({ failed: true, publishFailures: [] });
});

describe("recovering a planned run whose job will not pick it up again (frames-split §7.19)", () => {
  it("RR01 past the commit point it registers every output again and commits completed", async () => {
    runAs("running", "2026-11-24T08:00:00.000Z");
    await (await recovery())(TASK);
    expect(h.register).toHaveBeenCalledTimes(1);
    const completion = h.finish.mock.calls[0]![1] as MiniToolExecutionCompletion;
    expect(completion.error).toBeNull();
    expect(completion.outputs.map((output) => output.result)).toEqual([REGISTERED(0), REGISTERED(1)]);
    expect(h.failTask).not.toHaveBeenCalled();
  });

  it("RR02 before the commit point it commits every output failed as internal and registers nothing", async () => {
    runAs("running");
    await (await recovery())(TASK);
    const completion = h.finish.mock.calls[0]![1] as MiniToolExecutionCompletion;
    expect(completion.error).toEqual({ code: "internal" });
    expect(completion.outputs.map((output) => output.result)).toEqual([{ status: "failed", error: { code: "internal" } }, { status: "failed", error: { code: "internal" } }]);
    expect(h.register).not.toHaveBeenCalled();
  });

  it("RR03 a pending run is failed through failTask, never started", async () => {
    runAs("pending");
    await (await recovery())(TASK);
    expect(h.failTask).toHaveBeenCalledExactlyOnceWith(TASK, "internal");
    expect(h.finish).not.toHaveBeenCalled(); expect(h.register).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed", "cancelled"])("RR04 a %s run is left as it stands", async (status) => {
    runAs(status);
    await (await recovery())(TASK);
    expect(h.finish).not.toHaveBeenCalled(); expect(h.failTask).not.toHaveBeenCalled(); expect(h.register).not.toHaveBeenCalled();
  });

  it("RR05 a failed commit another pickup refused past its commit point is logged and left for the sweep", async () => {
    runAs("running");
    h.finish.mockRejectedValue(new Error("Past the commit point only the completed commit is taken"));
    await expect((await recovery())(TASK)).rejects.toThrow();
    expect(h.register).not.toHaveBeenCalled();
  });

  it("RR06 a registration throw past the commit point is not turned into a failure", async () => {
    runAs("running", "2026-11-24T08:00:00.000Z");
    h.register.mockRejectedValue(new Error("registration unavailable"));
    await expect((await recovery())(TASK)).rejects.toThrow("registration unavailable");
    expect(h.finish).not.toHaveBeenCalled(); expect(h.failTask).not.toHaveBeenCalled();
  });
});

describe("the failed-job cleanup ends a planned run through the recovery (frames-split §7.19)", () => {
  it("CL01 a terminally failed planned job is recovered by its task id", async () => {
    vi.doMock("@worker/handlers/mini-tool/recover-planned-run.js", () => ({ recoverPlannedRun: h.recover }));
    vi.resetModules();
    const { cleanupFailedJobNodes } = await import("@worker/handlers/failed-job-cleanup.js");
    const job = { name: "execute-mini-tool", finishedOn: 1, data: { taskId: TASK, source: "mini_tool", executionKind: "planned" } };
    await cleanupFailedJobNodes({} as never, job as never, "stalled");
    expect(h.recover).toHaveBeenCalledExactlyOnceWith(TASK);
    vi.doUnmock("@worker/handlers/mini-tool/recover-planned-run.js");
  });

  it("CL02 a recovery that throws is logged, and the cleanup does not throw", async () => {
    vi.doMock("@worker/handlers/mini-tool/recover-planned-run.js", () => ({ recoverPlannedRun: h.recover }));
    vi.resetModules();
    h.recover.mockRejectedValue(new Error("refused"));
    const { cleanupFailedJobNodes } = await import("@worker/handlers/failed-job-cleanup.js");
    const job = { name: "execute-mini-tool", finishedOn: 1, data: { taskId: TASK, source: "mini_tool", executionKind: "planned" } };
    await expect(cleanupFailedJobNodes({} as never, job as never, "stalled")).resolves.toBeTypeOf("number");
    expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ ctx: expect.objectContaining({ taskId: TASK }) }), "mini_tool_execution_recovery_failed");
    vi.doUnmock("@worker/handlers/mini-tool/recover-planned-run.js");
  });
});

describe("the planned run sweep (frames-split §7.19 巡检)", () => {
  /**
   * The sweep, loaded with the recovery mocked.
   * @returns It.
   */
  async function sweep(): Promise<(queue: Pick<Queue, "getJob">) => Promise<void>> {
    vi.doMock("@worker/handlers/mini-tool/recover-planned-run.js", () => ({ recoverPlannedRun: h.recover }));
    vi.resetModules();
    const module = await import("@worker/handlers/planned-run-sweep.js") as { sweepPlannedRuns?: (queue: Pick<Queue, "getJob">) => Promise<void> };
    expect(module.sweepPlannedRuns, "sweepPlannedRuns is exported").toBeTypeOf("function");
    return module.sweepPlannedRuns!;
  }
  /**
   * A queue whose jobs are in the given states; an id without one has no job.
   * @param states - Each job id's state.
   * @returns The queue.
   */
  function queue(states: Record<string, string>): Pick<Queue, "getJob"> {
    return { getJob: vi.fn(async (id: string) => states[id] === undefined ? undefined : { getState: async () => states[id] }) } as unknown as Pick<Queue, "getJob">;
  }
  const RUNNING = ["a1000000-0000-4000-8000-000000000001", "a1000000-0000-4000-8000-000000000002", "a1000000-0000-4000-8000-000000000003"];
  const PENDING = ["b1000000-0000-4000-8000-000000000001", "b1000000-0000-4000-8000-000000000002"];

  it("SW01 recovers a running run whose job has ended or is gone, and leaves one whose job still waits or runs", async () => {
    h.list.mockResolvedValue({ running: RUNNING, pending: [] });
    await (await sweep())(queue({ [RUNNING[0]!]: "failed", [RUNNING[2]!]: "active" }));
    expect(h.recover.mock.calls.map((call) => call[0])).toEqual([RUNNING[0], RUNNING[1]]);
  });

  it("SW02 fails a pending run that never waited whose job has ended or is gone, through failTask", async () => {
    h.list.mockResolvedValue({ running: [], pending: PENDING });
    await (await sweep())(queue({ [PENDING[1]!]: "delayed" }));
    expect(h.failTask.mock.calls).toEqual([[PENDING[0], "internal"]]);
    expect(h.recover).not.toHaveBeenCalled();
  });

  it("SW03 one run that fails is logged and the rest are still swept", async () => {
    h.list.mockResolvedValue({ running: RUNNING.slice(0, 2), pending: [] });
    h.recover.mockRejectedValueOnce(new Error("refused"));
    await (await sweep())(queue({}));
    expect(h.recover).toHaveBeenCalledTimes(2);
    expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ taskId: RUNNING[0] }), "planned_run_sweep_row_failed");
  });

  it("SW04 lists runs with the configured batch size and grace window", async () => {
    h.list.mockResolvedValue({ running: [], pending: [] });
    await (await sweep())(queue({}));
    const { getWorkerConfig } = await import("@breatic/core");
    const config = getWorkerConfig() as unknown as Record<string, number>;
    expect(config.planned_run_sweep_batch_size).toBeGreaterThan(0);
    expect(config.planned_run_sweep_grace_ms).toBeGreaterThan(0);
    expect(config.planned_run_sweep_interval_ms).toBeGreaterThan(0);
    expect(h.list).toHaveBeenCalledExactlyOnceWith(config.planned_run_sweep_batch_size, config.planned_run_sweep_grace_ms);
  });
});
