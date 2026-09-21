// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a failed run does to finish.
 *
 * Four things end a run that did not produce anything: the task row is
 * marked failed, each target node gets a history entry, the node's own row is
 * settled so the count stops saying a run is happening, and the project feed
 * gets the outcome. Each of the handler's exits used to spell all four out
 * for itself, and no two spelled them the same way — one skipped the history
 * and the feed entirely, two dropped the node id from the feed row, and one
 * stamped different text on the task row than on everything else.
 *
 * Two of the four record the ATTEMPT and two record the OUTCOME, which is why
 * only the second pair is gated: a retry still to come has not produced an
 * outcome yet, and settling the row then marks it failed while the next
 * attempt is still on its way.
 *
 * No real Redis / DB — everything is mocked.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const mockMarkFailed = vi.hoisted(() => vi.fn());
const mockRecordFailure = vi.hoisted(() => vi.fn());
const mockSettleTaskForNode = vi.hoisted(() => vi.fn());
const mockInsertActivity = vi.hoisted(() => vi.fn());
const mockPublishActivity = vi.hoisted(() => vi.fn());

vi.mock("@breatic/core", () => ({
  getStreamRedis: vi.fn(() => ({})),
  getWorkerConfig: vi.fn(() => ({})),
  getAgentConfig: vi.fn(() => ({})),
  projectActivitiesRepo: {
    insertGenerationFailedIfAbsent: mockInsertActivity,
    upsertGenerationSucceeded: vi.fn(),
  },
  publishActivityNew: mockPublishActivity,
  getStorageAdapter: vi.fn(),
  getRawEnvVar: vi.fn(),
  getUnderstandConfig: vi.fn(() => ({})),
  storageKey: vi.fn(),
  env: {},
  NotFoundError: class extends Error {},
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@breatic/domain", () => ({
  buildAgentConfig: vi.fn(),
  getModel: vi.fn(),
  generateTextRetry: vi.fn(),
  taskService: { markFailed: mockMarkFailed },
  assetService: {},
  creditLotService: {},
  resolveActiveProvider: vi.fn(),
  nodeHistoryService: { recordGenerationFailure: mockRecordFailure },
  settleTaskForNode: mockSettleTaskForNode,
  understandMediaAt: vi.fn(),
  UNDERSTAND_PINS: {},
  extractPromptText: vi.fn(),
}));
vi.mock("@breatic/shared", () => ({
  canvasSpaceDocName: (p: string, s: string) => `project-${p}/canvas-${s}`,
  extractPromptText: vi.fn(),
}));

import { finishFailedRun } from "@worker/handlers/dispatch.js";

const END = {
  streamRedis: {} as never,
  taskId: "task-1",
  projectId: "proj-1",
  spaceId: "space-1",
  canvasDocName: "project-proj-1/canvas-space-1",
  nodeIds: ["node-1"],
  userId: "user-1",
  model: "some-model",
  params: { a: 1 },
  // One word from the lane vocabulary. Widened to `string` by inference, this
  // fixture would stop saying which lane it stands for.
  source: "task" as const,
  toolName: undefined,
  errorMessage: "it broke",
  settles: true,
};

describe("a failed run that is the last word", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks the task row failed with the same text everything else carries", async () => {
    await finishFailedRun(END);

    expect(mockMarkFailed).toHaveBeenCalledWith("task-1", "it broke");
    expect(mockRecordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: "it broke" }),
    );
    expect(mockSettleTaskForNode).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ errorMessage: "it broke" }),
    );
  });

  it("gives every target node a history entry", async () => {
    await finishFailedRun({ ...END, nodeIds: ["node-1", "node-2"] });

    expect(mockRecordFailure).toHaveBeenCalledTimes(2);
  });

  it("settles the row each node opened", async () => {
    await finishFailedRun({ ...END, nodeIds: ["node-1", "node-2"] });

    expect(mockSettleTaskForNode).toHaveBeenCalledTimes(2);
  });

  // A feed row that names its node is one the reader can open from. The
  // handler's exits disagreed on this: one passed the id, two did not, so
  // the same single-node failure landed pinned or unpinned depending on
  // which way out the run took.
  it("pins the feed row to the node when the run had exactly one", async () => {
    await finishFailedRun(END);

    expect(mockInsertActivity).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "node-1", type: "generation:failed" }),
    );
  });

  // Several nodes have no single one to pin to, and the feed row says so
  // rather than picking one of them.
  it("leaves the feed row unpinned when the run had several", async () => {
    await finishFailedRun({ ...END, nodeIds: ["node-1", "node-2"] });

    expect(mockInsertActivity).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: null }),
    );
  });
});

describe("a failed attempt with a retry still to come", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The first pair records the attempt, which happened. The second pair
  // records the outcome, which has not been reached: settling now marks the
  // row failed while the next attempt is on its way, and the feed records
  // outcomes rather than attempts.
  it("records the attempt and leaves the outcome open", async () => {
    await finishFailedRun({ ...END, settles: false });

    expect(mockMarkFailed).toHaveBeenCalledTimes(1);
    expect(mockRecordFailure).toHaveBeenCalledTimes(1);
    expect(mockSettleTaskForNode).not.toHaveBeenCalled();
    expect(mockInsertActivity).not.toHaveBeenCalled();
  });
});

describe("a failed run with nothing on the canvas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes no history and settles nothing when it named no node", async () => {
    await finishFailedRun({ ...END, nodeIds: [] });

    expect(mockMarkFailed).toHaveBeenCalledTimes(1);
    expect(mockRecordFailure).not.toHaveBeenCalled();
    expect(mockSettleTaskForNode).not.toHaveBeenCalled();
  });

  it("settles nothing when the run belongs to no canvas space", async () => {
    await finishFailedRun({ ...END, canvasDocName: undefined });

    expect(mockSettleTaskForNode).not.toHaveBeenCalled();
    expect(mockRecordFailure).toHaveBeenCalledTimes(1);
  });

  it("records no feed row for a run with no project", async () => {
    await finishFailedRun({ ...END, projectId: undefined });

    expect(mockInsertActivity).not.toHaveBeenCalled();
  });
});
