// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Whether a settle call reports that the row holds its outcome (#1332).
 *
 * Two reports of one finish can race: both read the row while it is still
 * running, one moves it and the other's conditional update finds nothing to
 * move. The loser must still answer `landed`, because the row now holds the
 * outcome it asked for and the caller attaches the result content on that.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const findById = vi.fn();
const settleRunning = vi.fn();
const attachResult = vi.fn();
const countsFor = vi.fn();

vi.mock("@domain/node-task/node-task.repo.js", () => ({
  findById,
  settleRunning,
  attachResult,
  countsFor,
}));

const { settle } = await import("@domain/node-task/node-task.service.js");

const COUNTS = { running: 0, done: 1, failed: 0, expired: 0 };

/**
 * A task row as the repository returns it.
 * @param status - The row's status.
 * @returns The row.
 */
function row(status: string): Record<string, unknown> {
  return {
    id: "task-1",
    projectId: "project-1",
    nodeId: "node-1",
    status,
    startedAt: new Date(),
    budgetMs: 7_200_000,
    deletedAt: null,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  countsFor.mockResolvedValue(COUNTS);
});

describe("settle reports where the row ended", () => {
  it("lands when this call moved the row", async () => {
    findById.mockResolvedValue(row("running"));
    settleRunning.mockResolvedValue(true);

    const result = await settle({ taskId: "task-1", outcome: "done" });

    expect(result).toEqual({ applied: true, landed: true, counts: COUNTS });
  });

  it("lands when a concurrent report moved the row to the same outcome after this call read it", async () => {
    findById
      .mockResolvedValueOnce(row("running"))
      .mockResolvedValueOnce(row("done"));
    settleRunning.mockResolvedValue(false);

    const result = await settle({ taskId: "task-1", outcome: "done" });

    expect(result).toEqual({ applied: false, landed: true, counts: COUNTS });
  });

  it("does not land when a concurrent report moved the row to another outcome", async () => {
    findById
      .mockResolvedValueOnce(row("running"))
      .mockResolvedValueOnce(row("failed"));
    settleRunning.mockResolvedValue(false);

    const result = await settle({ taskId: "task-1", outcome: "done" });

    expect(result).toEqual({ applied: false, landed: false, counts: COUNTS });
  });
});
