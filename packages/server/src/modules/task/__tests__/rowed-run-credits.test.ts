// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, initCore } from "@breatic/core";
import { t } from "@breatic/shared";
import type * as DomainModule from "@breatic/domain";
import type * as CreditPrecheck from "@server/modules/credit/credit-precheck.service.js";

const open = vi.fn(async () => ({ id: "node-row", counts: { running: 1, done: 0, failed: 0, expired: 0 } }));
const settle = vi.fn(async () => ({ counts: { running: 0, done: 0, failed: 1, expired: 0 } }));
const setJobId = vi.fn(async () => undefined);
const markFailed = vi.fn(async () => undefined);
const releaseHold = vi.fn(async () => undefined);
const reserve = vi.fn(async (_project: string, _user: string, _task: string, _credits: number) => undefined);

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return {
    ...actual,
    nodeTaskService: { ...actual.nodeTaskService, open, settle },
    taskService: { ...actual.taskService, setJobId, markFailed },
    creditHoldService: { ...actual.creditHoldService, releaseHold },
  };
});
vi.mock("@server/modules/credit/credit-precheck.service.js", async (importOriginal) => ({
  ...await importOriginal<typeof CreditPrecheck>(),
  reserveForRun: reserve,
}));
vi.mock("@server/modules/task/publish-counts.js", () => ({ publishCountsQuietly: vi.fn(async () => undefined) }));

const { startRowedRun } = await import("@server/modules/task/generation-task.js");

beforeAll(() => {
  initCore({ DATABASE_URL: "postgres://localhost:5432/breatic_test", NODE_ENV: "test" });
});
beforeEach(() => vi.clearAllMocks());

describe("rowed run credit admission", () => {
  it.each([0, 12.5])("starts a run estimated at %s credits with the corresponding hold boundary", async (amount) => {
    const credits = vi.fn(async () => amount);
    const enqueue = vi.fn(async () => ({ id: "job" }));
    const result = await startRowedRun({
      taskId: "task", projectId: "project", spaceId: "space", nodeIds: ["node"],
      userId: "user", action: "mini_tool", label: "analysis", credits, enqueue,
      logTag: "test", logContext: {},
    });
    expect(result).toBe("pending");
    expect(credits).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(setJobId).toHaveBeenCalledWith("task", "job");
    if (amount === 0) expect(reserve).not.toHaveBeenCalled();
    else expect(reserve).toHaveBeenCalledExactlyOnceWith("project", "user", "task", amount);
  });

  it("still releases the hold and settles rows when paid admission is refused", async () => {
    reserve.mockRejectedValueOnce(new AppError(402, "insufficient credits"));
    const enqueue = vi.fn(async () => ({ id: "job" }));
    const result = await startRowedRun({
      taskId: "task", projectId: "project", spaceId: "space", nodeIds: ["node"],
      userId: "user", action: "mini_tool", label: "analysis", credits: async () => 12.5,
      enqueue, logTag: "test", logContext: {},
    });
    expect(result).toBe("failed");
    expect(enqueue).not.toHaveBeenCalled();
    expect(releaseHold).toHaveBeenCalledWith("task");
    expect(markFailed).toHaveBeenCalledWith("task", "no_credits");
    expect(settle).toHaveBeenCalledWith({ taskId: "node-row", outcome: "failed", errorMessage: "no_credits" });
  });

  it.each(["completed", "failed"] as const)("uses a lane's committed %s decision without legacy task or hold cleanup", async (status) => {
    const settleFailure = vi.fn(async () => status);
    const result = await startRowedRun({
      taskId: "task", projectId: "project", spaceId: "space", nodeIds: ["node"],
      userId: "user", action: "mini_tool", label: "analysis", credits: async () => 12.5,
      enqueue: async () => { throw new Error("fixture_queue_acknowledgement_failed"); },
      logTag: "test", settleFailure,
    });
    expect(result).toBe(status === "completed" ? "pending" : "failed");
    expect(settleFailure).toHaveBeenCalledExactlyOnceWith("internal");
    expect(releaseHold).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    if (status === "completed") expect(settle).not.toHaveBeenCalled();
    else expect(settle).toHaveBeenCalledExactlyOnceWith({ taskId: "node-row", outcome: "failed", errorMessage: "internal" });
  });

  it("propagates a failed lane transaction without falling back to destructive cleanup", async () => {
    const queueError = new Error("fixture_queue_failure"); const transactionError = new Error("fixture_transaction_failure");
    const settleFailure = vi.fn(async () => { throw transactionError; });
    const result: unknown = await startRowedRun({
      taskId: "task", projectId: "project", spaceId: "space", nodeIds: ["node"],
      userId: "user", action: "mini_tool", label: "analysis", credits: async () => 12.5,
      enqueue: async () => { throw queueError; }, logTag: "test", settleFailure,
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([queueError, transactionError]);
    expect(settleFailure).toHaveBeenCalledExactlyOnceWith("internal");
    expect(releaseHold).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("runs the lane failure transaction when opening a node row fails and preserves its existing 503 refusal", async () => {
    const openError = new Error("fixture_open_failure"); open.mockRejectedValueOnce(openError);
    const settleFailure = vi.fn(async (): Promise<"failed"> => "failed");
    const enqueue = vi.fn(async () => ({ id: "job" }));
    await expect(startRowedRun({
      taskId: "task", projectId: "project", spaceId: "space", nodeIds: ["node"],
      userId: "user", action: "mini_tool", label: "analysis", credits: async () => 12.5,
      enqueue, logTag: "test", settleFailure,
    })).rejects.toMatchObject({ name: "AppError", statusCode: 503, message: t("canvas.task.couldNotStart") });
    expect(settleFailure).toHaveBeenCalledExactlyOnceWith("internal");
    expect(enqueue).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(releaseHold).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
});
