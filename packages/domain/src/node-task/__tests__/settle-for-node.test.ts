// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Settling the task row for one node of a generation (#186, design §3.6).
 *
 * A generation may write several nodes, and each has its own row carrying the
 * shared job id. The worker knows which job it is running and which node it
 * just wrote, so that pair is what finds the row.
 *
 * Every one of the four places the worker announces an outcome goes through
 * here, so the recount and the event are written once.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const findByTaskAndNode = vi.fn();
const settle = vi.fn();
const emit = vi.fn();

vi.mock("@domain/node-task/node-task.repo.js", () => ({
  findByTaskAndNode,
}));

vi.mock("@domain/node-task/node-task.service.js", () => ({
  settle,
}));

vi.mock("@domain/canvas-node/node-state-events.js", () => ({
  emitNodeTaskCounts: emit,
}));

const { settleTaskForNode } = await import(
  "@domain/node-task/settle-for-node.js"
);

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SPACE = "33333333-3333-4333-8333-333333333333";
const NODE = "44444444-4444-4444-8444-444444444444";
const DOC = `project-${PROJECT}/canvas-${SPACE}`;

const COUNTS = { running: 0, done: 1, failed: 0, expired: 0 };
const REDIS = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  findByTaskAndNode.mockResolvedValue({ id: "row-1", projectId: PROJECT, nodeId: NODE });
  settle.mockResolvedValue({ applied: true, counts: COUNTS });
});

describe("settling one node's row of a generation", () => {
  it("finds the row by the job and the node together", async () => {
    await settleTaskForNode(REDIS, DOC, {
      taskId: "job-1",
      nodeId: NODE,
      outcome: "done",
    });

    expect(findByTaskAndNode).toHaveBeenCalledWith("job-1", NODE);
  });

  it("moves it to the outcome and publishes the node's counts", async () => {
    await settleTaskForNode(REDIS, DOC, {
      taskId: "job-1",
      nodeId: NODE,
      outcome: "done",
      nodeHistoryId: "history-1",
    });

    expect(settle).toHaveBeenCalledWith({
      taskId: "row-1",
      outcome: "done",
      nodeHistoryId: "history-1",
    });
    expect(emit).toHaveBeenCalledWith(REDIS, DOC, NODE, COUNTS, undefined);
  });

  it("carries the content on the transition that reached done", async () => {
    const result = {
      content: "https://cdn.invalid/out.png",
      coverUrl: null,
      width: null,
      height: null,
      duration: null,
    };

    await settleTaskForNode(REDIS, DOC, {
      taskId: "job-1",
      nodeId: NODE,
      outcome: "done",
      result,
    });

    expect(emit).toHaveBeenCalledWith(REDIS, DOC, NODE, COUNTS, result);
  });

  it("leaves the content alone when the row had already settled", async () => {
    // The deadline passed and something else finished this node first. The
    // numbers still go out; what is on the node stays where it is.
    settle.mockResolvedValue({ applied: false, counts: COUNTS });

    await settleTaskForNode(REDIS, DOC, {
      taskId: "job-1",
      nodeId: NODE,
      outcome: "done",
      result: {
        content: "https://cdn.invalid/out.png",
        coverUrl: null,
        width: null,
        height: null,
        duration: null,
      },
    });

    expect(emit).toHaveBeenCalledWith(REDIS, DOC, NODE, COUNTS, undefined);
  });

  it("does nothing for a node this job opened no row on", async () => {
    findByTaskAndNode.mockResolvedValue(null);

    await settleTaskForNode(REDIS, DOC, {
      taskId: "job-1",
      nodeId: NODE,
      outcome: "failed",
      errorMessage: "provider said no",
    });

    expect(settle).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("records why on a failure", async () => {
    await settleTaskForNode(REDIS, DOC, {
      taskId: "job-1",
      nodeId: NODE,
      outcome: "failed",
      errorMessage: "provider said no",
    });

    expect(settle).toHaveBeenCalledWith({
      taskId: "row-1",
      outcome: "failed",
      errorMessage: "provider said no",
    });
  });
});
