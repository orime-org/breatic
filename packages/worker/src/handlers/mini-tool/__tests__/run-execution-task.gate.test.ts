// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A planned run passes the running-task gate before it first runs (inner#1968 design 3.9): it starts when its person runs
 * fewer tasks than the limit, or goes back on the delayed queue without starting; its budget counts from the start the
 * gate gave it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DelayedError, type Job } from "bullmq";
import type * as coreModule from "@breatic/core";
import type * as domainModule from "@breatic/domain";
import type { MiniToolExecutionJob } from "@breatic/domain";
import { StillRunning } from "@worker/handlers/still-running.js";
import { runMiniToolExecutionTask } from "../run-execution-task.js";

const h = vi.hoisted(() => ({ gate: vi.fn(), start: vi.fn(), deadline: vi.fn(), delay: vi.fn(), finish: vi.fn(), run: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@breatic/core", async (original) => {
  const actual = await original<typeof coreModule>();
  return { ...actual, logger: h.logger as unknown as typeof actual.logger, getStreamRedis: () => ({}) };
});
vi.mock("@breatic/domain", async (original) => {
  const actual = await original<typeof domainModule>();
  return { ...actual, runningSlotService: { ...actual.runningSlotService, startWithinLimit: h.gate },
    miniToolExecutionService: { ...actual.miniToolExecutionService, startMiniToolExecution: h.start } };
});
vi.mock("@worker/handlers/task-deadline.js", () => ({ taskDeadline: h.deadline }));
vi.mock("@worker/handlers/mini-tool/run-video-tool.js", () => ({ runMiniToolVideoTool: h.run }));
vi.mock("@worker/handlers/mini-tool/execution-completion.js", () => ({ finishMiniToolExecutionAndNotify: h.finish, commitMiniToolExecutionProgress: vi.fn() }));
vi.mock("@worker/handlers/dispatch.js", () => ({ isTerminalAttempt: () => false, verifyJobLockOwnership: async () => true }));

const TASK = "50000000-0000-4000-8000-000000000001";
const STARTED = new Date("2026-11-22T01:00:00.000Z");
const CREATED = new Date("2026-11-22T00:00:00.000Z");
const RESUME = 1_900_000_000_000;

/**
 * A queue delivery of the accepted run.
 * @returns The job.
 */
function job(): Job<MiniToolExecutionJob> {
  return { id: "queue-job", data: { taskId: TASK, source: "mini_tool", executionKind: "planned" }, attemptsMade: 0, stalledCounter: 0,
    moveToDelayed: h.delay } as unknown as Job<MiniToolExecutionJob>;
}

beforeEach(() => {
  vi.resetAllMocks();
  const outputs = [{ outputIndex: 0, nodeId: "40000000-0000-4000-8000-000000000001", result: null, late: false }];
  h.start.mockResolvedValue({ task: { userId: "u", createdAt: CREATED, startedAt: STARTED },
    execution: { projectId: "p", spaceId: "s", planFingerprint: "f".repeat(64), outputs },
    record: { status: "running", resultVersion: 0, outputs } });
  h.deadline.mockResolvedValue(Date.now() + 3_600_000);
  h.run.mockResolvedValue({ results: new Map([[0, { status: "registered" }]]), waiting: false });
  h.finish.mockResolvedValue({ record: { status: "completed" } });
});
afterEach(() => vi.restoreAllMocks());

describe("a planned run's first pickup passes the running-task gate (inner#1968 design 3.9)", () => {
  it("M2-01 asks the gate before the pickup starts the run, and budgets from the gate's start", async () => {
    h.gate.mockResolvedValue({ outcome: "started", started: STARTED, publishFailures: [] });
    expect(await runMiniToolExecutionTask(job(), "token")).toEqual({ runId: TASK, status: "completed" });
    expect(h.gate).toHaveBeenCalledExactlyOnceWith({ id: TASK, jobId: "queue-job" });
    expect(h.gate.mock.invocationCallOrder[0]).toBeLessThan(h.start.mock.invocationCallOrder[0]!);
    expect(h.deadline).toHaveBeenCalledExactlyOnceWith(TASK, STARTED);
  });

  it("M2-02 a run that must wait goes back on the delayed queue without starting", async () => {
    h.gate.mockRejectedValue(new StillRunning(RESUME));
    await expect(runMiniToolExecutionTask(job(), "token")).rejects.toBeInstanceOf(DelayedError);
    expect(h.delay).toHaveBeenCalledExactlyOnceWith(RESUME, "token");
    expect(h.start).not.toHaveBeenCalled();
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it("M2-03 a run the gate finds ended is read as it stands, never started again", async () => {
    h.gate.mockResolvedValue({ outcome: "ended", publishFailures: [] });
    h.start.mockResolvedValue({ task: { userId: "u", createdAt: CREATED, startedAt: null },
      execution: { projectId: "p", spaceId: "s", planFingerprint: "f".repeat(64), outputs: [] },
      record: { status: "cancelled", resultVersion: 0, outputs: [] } });
    expect(await runMiniToolExecutionTask(job(), "token")).toEqual({ runId: TASK, status: "cancelled" });
    expect(h.run).not.toHaveBeenCalled();
  });
});
