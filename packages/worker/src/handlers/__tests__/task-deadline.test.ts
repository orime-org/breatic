// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * When a task's two hours run out (inner#1337 §3.2).
 *
 * A task bound to canvas nodes ends with the earliest of their rows. A task
 * bound to none still has two hours, counted from when it started running
 * (inner#1968 design 3.9: time spent waiting for a running slot does not
 * count), as the caller read it off the task row.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ deadlineFor: vi.fn() }));

vi.mock("@breatic/domain", () => ({ nodeTaskService: { deadlineFor: h.deadlineFor } }));
vi.mock("@breatic/core", () => ({ budgetDeadlineFrom: (startedAt: number) => startedAt + 7_200_000 }));

const { taskDeadline } = await import("@worker/handlers/task-deadline.js");

const STARTED = new Date(1_800_000_000_000);

beforeEach(() => {
  h.deadlineFor.mockReset();
});

describe("taskDeadline", () => {
  it("is the deadline of the task's node rows when it has any", async () => {
    h.deadlineFor.mockResolvedValue(1_800_000_500_000);

    await expect(taskDeadline("task-1", STARTED)).resolves.toBe(1_800_000_500_000);
  });

  it("is two hours after the task started when it has no node rows", async () => {
    h.deadlineFor.mockResolvedValue(null);

    await expect(taskDeadline("task-1", STARTED)).resolves.toBe(1_800_000_000_000 + 7_200_000);
  });
});
