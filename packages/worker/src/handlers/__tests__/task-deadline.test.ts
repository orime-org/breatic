// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * When a task's two hours run out (inner#1337 §3.2).
 *
 * A task bound to canvas nodes ends with the earliest of their rows. A task
 * bound to none still has two hours, counted from when it was created — the
 * same moment a node's row would have started counting.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  deadlineFor: vi.fn(),
  getByIdInternal: vi.fn(),
}));

vi.mock("@breatic/domain", () => ({
  nodeTaskService: { deadlineFor: h.deadlineFor },
  taskService: { getByIdInternal: h.getByIdInternal },
}));
vi.mock("@breatic/core", () => ({
  getNodeTaskConfig: () => ({ default_budget_ms: 7_200_000 }),
}));

const { taskDeadline } = await import("@worker/handlers/task-deadline.js");

beforeEach(() => {
  h.deadlineFor.mockReset();
  h.getByIdInternal.mockReset();
});

describe("taskDeadline", () => {
  it("is the deadline of the task's node rows when it has any", async () => {
    h.deadlineFor.mockResolvedValue(1_800_000_000_000);

    await expect(taskDeadline("task-1")).resolves.toBe(1_800_000_000_000);
    expect(h.getByIdInternal).not.toHaveBeenCalled();
  });

  it("is two hours after the task was created when it has no node rows", async () => {
    h.deadlineFor.mockResolvedValue(null);
    h.getByIdInternal.mockResolvedValue({ createdAt: new Date(1_800_000_000_000) });

    await expect(taskDeadline("task-1")).resolves.toBe(1_800_000_000_000 + 7_200_000);
  });

  it("is null for a task that does not exist", async () => {
    h.deadlineFor.mockResolvedValue(null);
    h.getByIdInternal.mockResolvedValue(null);

    await expect(taskDeadline("task-1")).resolves.toBeNull();
  });
});
