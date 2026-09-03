// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

vi.mock("@breatic/domain", () => ({
  nodeTaskService: { open },
  emitNodeTaskCounts: emit,
}));

vi.mock("@breatic/core", () => ({
  getStreamRedis: () => ({}),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  getNodeTaskConfig: () => ({
    upload: {
      min_budget_ms: 900_000,
      max_budget_ms: 43_200_000,
      cover_reserve_ms: 600_000,
    },
    generation: { budget_ms: 14_400_000 },
  }),
}));

const { openGenerationTasks } = await import(
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
        startedByUserId: "user-1",
        taskId: "job-1",
        label: "seedream-4",
      });
    }
  });

  it("gives each row the configured generation budget", async () => {
    await openGenerationTasks({
      projectId: PROJECT,
      spaceId: SPACE,
      nodeIds: [NODE_A],
      startedByUserId: "user-1",
      taskId: "job-1",
      label: "seedream-4",
    });

    expect(open.mock.calls[0]![0].budgetMs).toBe(14_400_000);
  });

  it("publishes each node's counts", async () => {
    await openGenerationTasks({
      projectId: PROJECT,
      spaceId: SPACE,
      nodeIds: [NODE_A, NODE_B],
      startedByUserId: "user-1",
      taskId: "job-1",
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
      label: "seedream-4",
    });

    expect(open).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("carries on when one node's row cannot be opened", async () => {
    // The other nodes in this run are still going to be written to, and the
    // job is already on its way. A node without a row shows no count for it;
    // it does not stop the run.
    open.mockRejectedValueOnce(new Error("no database"));

    await expect(
      openGenerationTasks({
        projectId: PROJECT,
        spaceId: SPACE,
        nodeIds: [NODE_A, NODE_B],
        startedByUserId: "user-1",
        taskId: "job-1",
        label: "seedream-4",
      }),
    ).resolves.toBeUndefined();

    expect(open).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
