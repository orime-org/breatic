// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A planned run is one whole (frames-split design §7.19): its outputs are staged while it runs, and once every output is
 * reported the pickup writes the run's commit point, registers every output with a presentation deadline counted from
 * that moment and commits completed once. The first output that fails for good fails every output. Past the commit
 * point nothing maps a throw to a failure or to expired: a registration throw goes back to the queue, and a pickup that
 * finds the commit point registers without running the tool again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type * as coreModule from "@breatic/core";
import type * as domainModule from "@breatic/domain";
import type { MiniToolExecutionCompletion, MiniToolExecutionJob } from "@breatic/domain";
import { runMiniToolExecutionTask } from "../run-execution-task.js";

const h = vi.hoisted(() => ({ start: vi.fn(), mark: vi.fn(), deadline: vi.fn(), finish: vi.fn(), run: vi.fn(), register: vi.fn(), terminal: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@breatic/core", async (original) => {
  const actual = await original<typeof coreModule>();
  return { ...actual, logger: h.logger as unknown as typeof actual.logger, getStreamRedis: () => ({}) };
});
vi.mock("@breatic/domain", async (original) => {
  const actual = await original<typeof domainModule>();
  return { ...actual,
    runningSlotService: { ...actual.runningSlotService, startWithinLimit: async () => ({ outcome: "started", started: new Date(), publishFailures: [] }) },
    miniToolExecutionService: { ...actual.miniToolExecutionService, startMiniToolExecution: h.start, markMiniToolExecutionCommitPoint: h.mark } };
});
vi.mock("@worker/handlers/task-deadline.js", () => ({ taskDeadline: h.deadline }));
vi.mock("@worker/handlers/mini-tool/run-video-tool.js", async (original) => ({ ...await original<Record<string, unknown>>(), runMiniToolVideoTool: h.run, registerReportedOutputs: h.register }));
vi.mock("@worker/handlers/mini-tool/execution-completion.js", () => ({ finishMiniToolExecutionAndNotify: h.finish }));
vi.mock("@worker/handlers/dispatch.js", () => ({ isTerminalAttempt: h.terminal, verifyJobLockOwnership: async () => true }));

const TASK = "50000000-0000-4000-8000-000000000001";
const NODES = ["40000000-0000-4000-8000-000000000001", "40000000-0000-4000-8000-000000000002"];
const REGISTERED = (index: number): Record<string, unknown> => ({ status: "registered", assetId: `90000000-0000-4000-8000-00000000000${index}` });
const ERROR = { code: "mini_tool_failed", message: "tool_failed" };

/**
 * A queue delivery of the accepted run.
 * @returns The job.
 */
function job(): Job<MiniToolExecutionJob> {
  return { id: "queue-job", data: { taskId: TASK, source: "mini_tool", executionKind: "planned" }, attemptsMade: 0, stalledCounter: 0, moveToDelayed: vi.fn() } as unknown as Job<MiniToolExecutionJob>;
}

/**
 * The record the pickup starts from.
 * @param commitPoint - Its commit point, if it has one.
 */
function startFrom(commitPoint?: string): void {
  const outputs = NODES.map((nodeId, outputIndex) => ({ outputIndex, nodeId, recipe: { kind: "frame", frameIndex: outputIndex }, result: null }));
  h.start.mockResolvedValue({ task: { userId: "u", createdAt: new Date(), startedAt: new Date() },
    execution: { projectId: "p", spaceId: "s", planFingerprint: "f".repeat(64), outputs: outputs.map(({ result: _r, ...output }) => output) },
    record: { status: "running", resultVersion: 0, outputs, ...(commitPoint === undefined ? {} : { commitPoint }) } });
}

/**
 * The completion the pickup committed.
 * @returns It.
 */
function committed(): MiniToolExecutionCompletion {
  expect(h.finish).toHaveBeenCalledTimes(1);
  return h.finish.mock.calls[0]![1] as MiniToolExecutionCompletion;
}

beforeEach(() => {
  vi.resetAllMocks();
  startFrom();
  h.deadline.mockResolvedValue(Date.now() + 3_600_000);
  h.terminal.mockReturnValue(false);
  h.run.mockResolvedValue({ results: new Map([[0, { status: "reported", stepId: "s0" }], [1, { status: "reported", stepId: "s1" }]]), waiting: false });
  h.mark.mockResolvedValue({ state: "committed", record: { status: "running", commitPoint: "2026-11-24T08:00:00.000Z" } });
  h.register.mockResolvedValue(new Map([[0, REGISTERED(0)], [1, REGISTERED(1)]]));
  h.finish.mockResolvedValue({ record: { status: "completed" } });
});
afterEach(() => vi.restoreAllMocks());

describe("the commit point and the one registration (frames-split §7.19)", () => {
  it("WC01 once every output is reported, writes the commit point, registers every output, then commits completed", async () => {
    expect(await runMiniToolExecutionTask(job(), "token")).toEqual({ runId: TASK, status: "completed" });
    expect(h.mark).toHaveBeenCalledExactlyOnceWith(TASK);
    expect(h.mark.mock.invocationCallOrder[0]).toBeLessThan(h.register.mock.invocationCallOrder[0]!);
    expect(h.register.mock.invocationCallOrder[0]).toBeLessThan(h.finish.mock.invocationCallOrder[0]!);
    const completion = committed();
    expect(completion.error).toBeNull();
    expect(completion.outputs.map((output) => output.result)).toEqual([REGISTERED(0), REGISTERED(1)]);
  });

  it("WC02 registers with a presentation deadline of two hours from the registration", async () => {
    const before = Date.now();
    await runMiniToolExecutionTask(job(), "token");
    const deadlineAt = h.register.mock.calls[0]![1] as number;
    const budget = 2 * 3_600_000;
    expect(deadlineAt).toBeGreaterThanOrEqual(before + budget);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + budget);
  });

  it("WC03 a commit point another path refused ends the pickup without registering or committing", async () => {
    h.mark.mockResolvedValue({ state: "ended", record: { status: "failed" } });
    expect(await runMiniToolExecutionTask(job(), "token")).toEqual({ runId: TASK, status: "failed" });
    expect(h.register).not.toHaveBeenCalled(); expect(h.finish).not.toHaveBeenCalled();
  });

  it("WC04 a pickup that finds the commit point registers and completes without running the tool", async () => {
    startFrom("2026-11-24T08:00:00.000Z");
    expect(await runMiniToolExecutionTask(job(), "token")).toEqual({ runId: TASK, status: "completed" });
    expect(h.run).not.toHaveBeenCalled();
    expect(h.register).toHaveBeenCalledTimes(1);
    expect(committed().outputs.map((output) => output.result)).toEqual([REGISTERED(0), REGISTERED(1)]);
  });

  it("WC05 a pickup past the commit point and past the deadline still registers and completes, never expired", async () => {
    startFrom("2026-11-24T08:00:00.000Z");
    h.deadline.mockResolvedValue(Date.now() - 10 * 3_600_000);
    expect(await runMiniToolExecutionTask(job(), "token")).toEqual({ runId: TASK, status: "completed" });
    expect(committed().error).toBeNull();
  });

  it.each([false, true])("WC06 a registration throw past the commit point goes back to the queue (terminal attempt: %s)", async (terminal) => {
    h.terminal.mockReturnValue(terminal);
    const error = new Error("registration unavailable"); h.register.mockRejectedValue(error);
    await expect(runMiniToolExecutionTask(job(), "token")).rejects.toBe(error);
    expect(h.finish).not.toHaveBeenCalled();
  });

  it("WC07 a registration throw on a pickup that found the commit point also goes back to the queue", async () => {
    startFrom("2026-11-24T08:00:00.000Z"); h.terminal.mockReturnValue(true);
    const error = new Error("registration unavailable"); h.register.mockRejectedValue(error);
    await expect(runMiniToolExecutionTask(job(), "token")).rejects.toBe(error);
    expect(h.finish).not.toHaveBeenCalled();
  });
});

describe("the first output that fails for good fails the run (frames-split §7.19)", () => {
  it("WF01 every output fails with the first failure's error; no commit point, no registration", async () => {
    h.run.mockResolvedValue({ results: new Map([[0, { status: "reported", stepId: "s0" }], [1, { status: "failed", error: ERROR }]]), waiting: false });
    await runMiniToolExecutionTask(job(), "token");
    const completion = committed();
    expect(completion.error).toEqual(ERROR);
    expect(completion.outputs.map((output) => output.result)).toEqual([{ status: "failed", error: ERROR }, { status: "failed", error: ERROR }]);
    expect(h.mark).not.toHaveBeenCalled(); expect(h.register).not.toHaveBeenCalled();
  });

  it("WF02 a failure while another output still runs fails the run at once, without waiting for it", async () => {
    h.run.mockResolvedValue({ results: new Map([[1, { status: "failed", error: { code: "expired" } }]]), waiting: true });
    await runMiniToolExecutionTask(job(), "token");
    expect(committed().outputs.map((output) => output.result)).toEqual([{ status: "failed", error: { code: "expired" } }, { status: "failed", error: { code: "expired" } }]);
  });

  it("WF03 a throw before the commit point on the last attempt fails every output as internal", async () => {
    h.terminal.mockReturnValue(true); h.run.mockRejectedValue(new Error("grant store unavailable"));
    await runMiniToolExecutionTask(job(), "token");
    const completion = committed();
    expect(completion.error).toEqual({ code: "internal" });
    expect(completion.outputs.map((output) => output.result)).toEqual([{ status: "failed", error: { code: "internal" } }, { status: "failed", error: { code: "internal" } }]);
  });

  it("WF04 outputs still running and none failed: the pickup waits, commits nothing and writes no commit point", async () => {
    h.run.mockResolvedValue({ results: new Map([[0, { status: "reported", stepId: "s0" }]]), waiting: true });
    await expect(runMiniToolExecutionTask(job(), "token")).rejects.toBeDefined();
    expect(h.mark).not.toHaveBeenCalled(); expect(h.finish).not.toHaveBeenCalled();
  });
});
