// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, initCore } from "@breatic/core";
import type * as DomainModule from "@breatic/domain";
import type * as CreditPrecheck from "@server/modules/payment/credit-precheck.service.js";

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
vi.mock("@server/modules/payment/credit-precheck.service.js", async (importOriginal) => ({
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
});
