// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * When a task's two hours run out (inner#1337 §3.2).
 *
 * A task bound to canvas nodes ends with the earliest of their rows. A task
 * bound to none still has two hours, counted from when it started running
 * (inner#1968 design 3.9: time spent waiting for a running slot does not
 * count), read off the task row; the caller's start is the fallback.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ deadlineFor: vi.fn(), getByIdInternal: vi.fn() }));

vi.mock("@breatic/domain", () => ({ nodeTaskService: { deadlineFor: h.deadlineFor }, taskService: { getByIdInternal: h.getByIdInternal } }));
vi.mock("@breatic/core", () => ({ budgetDeadlineFrom: (startedAt: number) => startedAt + 7_200_000 }));

const { taskDeadline } = await import("@worker/handlers/task-deadline.js");

const CREATED = new Date(1_800_000_000_000);

beforeEach(() => {
  h.deadlineFor.mockReset();
  h.getByIdInternal.mockReset();
  h.getByIdInternal.mockResolvedValue(null);
});

describe("taskDeadline", () => {
  it("is the deadline of the task's node rows when it has any", async () => {
    h.deadlineFor.mockResolvedValue(1_800_000_500_000);

    await expect(taskDeadline("task-1", CREATED)).resolves.toBe(1_800_000_500_000);
  });

  it("is two hours after the task started when it has no node rows", async () => {
    h.deadlineFor.mockResolvedValue(null);
    h.getByIdInternal.mockResolvedValue({ startedAt: new Date(1_800_000_900_000) });

    await expect(taskDeadline("task-1", CREATED)).resolves.toBe(1_800_000_900_000 + 7_200_000);
  });

  it("counts from the caller's start when the row records none", async () => {
    h.deadlineFor.mockResolvedValue(null);

    await expect(taskDeadline("task-1", CREATED)).resolves.toBe(1_800_000_000_000 + 7_200_000);
  });

  it("fails for a task that does not exist: there is nothing to run against", async () => {
    h.deadlineFor.mockResolvedValue(null);

    await expect(taskDeadline("task-1", undefined)).rejects.toThrow("task task-1 has no row to run against");
  });
});
