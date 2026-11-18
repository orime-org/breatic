// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Opening the task rows a generation leaves on its target nodes (#186, §4.2).
 *
 * A generation and a mini-tool both write to nodes the caller named, and one
 * request may name several — the design's own words: "一次请求带多个
 * `node_ids` 时按节点各建一条". So this opens one row per node, all carrying
 * the same job id, and publishes each node's counts.
 *
 * A run that names no node opens nothing. The counts live in a node's corner,
 * and an append-mode generation whose result node the browser creates has no
 * corner to count in yet.
 */

import type * as coreModule from "@breatic/core";
import { describe, it, expect, vi, beforeEach } from "vitest";

/** What `nodeTaskService.open` is called with. */
interface OpenArgs {
  projectId: string;
  spaceId: string;
  nodeId: string;
  kind: string;
  startedByUserId: string;
  budgetMs: number;
  label: string;
  taskId: string;
}

const open = vi.fn(async (_opts: OpenArgs) => ({
  id: "task-row-1",
  counts: { running: 1, done: 0, failed: 0, expired: 0 },
}));
const emit = vi.fn();
const settle = vi.fn(async (_opts: { taskId: string; outcome: string; errorMessage: string }) => ({
  counts: { running: 0, done: 0, failed: 1, expired: 0 },
}));

const releaseHold = vi.fn(async (_taskId: string) => undefined);
const reserveForRun = vi.fn(async (_projectId: string, _userId: string, _taskId: string, _credits: number) => undefined);
const loggerError = vi.fn();

vi.mock("@breatic/domain", () => ({
  nodeTaskService: { open, settle },
  creditHoldService: { releaseHold },
  emitNodeTaskCounts: emit,
}));

vi.mock("@server/modules/payment/credit-precheck.service.js", () => ({ reserveForRun }));

vi.mock("@server/modules/project/project.service.js", () => ({ assertAccess: vi.fn() }));

vi.mock("@breatic/core", async () => {
  // The real AppError, because what this suite asserts about a refused run is
  // the status it carries.
  const actual = await vi.importActual<typeof coreModule>("@breatic/core");
  return {
    AppError: actual.AppError,
    getStreamRedis: () => ({}),
    logger: { error: loggerError, warn: vi.fn(), info: vi.fn() },
    getNodeTaskConfig: () => ({ default_budget_ms: 7_200_000 }),
  };
});

const { openGenerationTasks, holdRowedRun } = await import(
  "@server/modules/task/generation-task.js"
);

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SPACE = "33333333-3333-4333-8333-333333333333";
const NODE_A = "44444444-4444-4444-8444-44444444444a";
const NODE_B = "44444444-4444-4444-8444-44444444444b";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("opening a generation's task rows", () => {
  it("opens one row per target node, all naming the same job", async () => {
    await openGenerationTasks({
      projectId: PROJECT,
      spaceId: SPACE,
      nodeIds: [NODE_A, NODE_B],
      startedByUserId: "user-1",
      taskId: "job-1",
      action: "generate",
      label: "seedream-4",
    });

    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls.map((c) => c[0].nodeId)).toEqual([
      NODE_A,
      NODE_B,
    ]);
    for (const [args] of open.mock.calls) {
      expect(args).toMatchObject({
        projectId: PROJECT,
        spaceId: SPACE,
        kind: "generation",
        action: "generate",
        startedByUserId: "user-1",
        taskId: "job-1",
        label: "seedream-4",
      });
    }
  });

  it("gives each row the configured task budget", async () => {
    await openGenerationTasks({
      projectId: PROJECT,
      spaceId: SPACE,
      nodeIds: [NODE_A],
      startedByUserId: "user-1",
      taskId: "job-1",
      action: "generate",
      label: "seedream-4",
    });

    expect(open.mock.calls[0]![0].budgetMs).toBe(7_200_000);
  });

  it("publishes each node's counts", async () => {
    await openGenerationTasks({
      projectId: PROJECT,
      spaceId: SPACE,
      nodeIds: [NODE_A, NODE_B],
      startedByUserId: "user-1",
      taskId: "job-1",
      action: "generate",
      label: "seedream-4",
    });

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.map((c) => c[2])).toEqual([NODE_A, NODE_B]);
    expect(emit.mock.calls[0]![1]).toBe(`project-${PROJECT}/canvas-${SPACE}`);
  });

  it("opens nothing when the run names no node", async () => {
    await openGenerationTasks({
      projectId: PROJECT,
      spaceId: SPACE,
      nodeIds: [],
      startedByUserId: "user-1",
      taskId: "job-1",
      action: "generate",
      label: "seedream-4",
    });

    expect(open).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("stops the run when a node's row cannot be opened", async () => {
    // The row is the only path a result takes back to the node, so opening
    // one is a precondition for starting the work rather than a nicety
    // alongside it (design §4.6.5). Carrying on would bill the user for a
    // result that can never be delivered.
    open.mockRejectedValueOnce(new Error("no database"));

    await expect(
      openGenerationTasks({
        projectId: PROJECT,
        spaceId: SPACE,
        nodeIds: [NODE_A, NODE_B],
        startedByUserId: "user-1",
        taskId: "job-1",
        action: "generate",
        label: "seedream-4",
      }),
      // Answered the way the upload leg answers an unarmed timer: to the
      // user these are the same thing, so they read the same sentence.
    ).rejects.toMatchObject({ statusCode: 503 });

    // The second node is never reached: nothing about this run is going to
    // happen, so opening more rows for it would only leave them to expire.
    expect(open).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it("ends the rows it already opened when a later node's row cannot be opened (inner#1968 H-41)", async () => {
    // A row left running would count a run that is not happening until the
    // two-hour harvest ends it.
    open.mockResolvedValueOnce({ id: "row-a", counts: { running: 1, done: 0, failed: 0, expired: 0 } });
    open.mockRejectedValueOnce(new Error("no database"));

    await expect(
      openGenerationTasks({
        projectId: PROJECT,
        spaceId: SPACE,
        nodeIds: [NODE_A, NODE_B],
        startedByUserId: "user-1",
        taskId: "job-1",
        action: "generate",
        label: "seedream-4",
      }),
    ).rejects.toMatchObject({ statusCode: 503 });

    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith({ taskId: "row-a", outcome: "failed", errorMessage: "internal" });
  });
});

describe("holding a rowed run's credits before its row (inner#1968, design 3.10)", () => {
  const run = (create: () => Promise<string>): Promise<string> =>
    holdRowedRun({ taskId: "t1", projectId: PROJECT, userId: "u1", credits: async () => 2, create });

  it("releases nothing when the admission itself is refused, and keeps the refusal", async () => {
    const refusal = new Error("refused");
    reserveForRun.mockRejectedValueOnce(refusal);
    const create = vi.fn(async () => "row");

    await expect(run(create)).rejects.toBe(refusal);
    expect(create).not.toHaveBeenCalled();
    expect(releaseHold).not.toHaveBeenCalled();
  });

  it("keeps the row's own failure when releasing the hold fails too, and logs the release", async () => {
    const writeFailed = new Error("row write failed");
    const releaseFailed = new Error("release failed");
    releaseHold.mockRejectedValueOnce(releaseFailed);

    await expect(run(async () => { throw writeFailed; })).rejects.toBe(writeFailed);
    expect(releaseHold).toHaveBeenCalledWith("t1");
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ err: releaseFailed, taskId: "t1" }), "credit_hold_release_failed");
  });
});
