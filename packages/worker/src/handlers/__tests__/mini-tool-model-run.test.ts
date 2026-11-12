// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A model mini-tool runs on the model its registry entry pins (inner#888 A11), as a model run through provider
 * (inner#1743): the tool's own model, the modality and the number of outputs it writes, whatever the request names.
 * How the run's prompt and params are made ready is `model-task.test.ts`'s.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ runModelTask: vi.fn() }));

vi.mock("@breatic/core", () => ({
  env: {},
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getStreamRedis: vi.fn(),
  getWorkerConfig: vi.fn(),
  getAgentConfig: vi.fn(),
  projectActivitiesRepo: {},
  publishActivityNew: vi.fn(),
  getStorageAdapter: vi.fn(),
  NotFoundError: class NotFoundError extends Error {},
}));
vi.mock("@breatic/domain", () => ({
  taskService: {},
  nodeHistoryService: {},
  settleTaskForNode: vi.fn(),
  creditsForUsd: (usd: number) => usd * 100,
}));
vi.mock("@worker/handlers/model-task.js", () => ({ runModelTask: h.runModelTask, abandonedCosts: async () => [] }));

import { runMiniTool } from "@worker/handlers/dispatch.js";

const RUN = { userId: "u1", projectId: "p1", taskId: "task-1", deadlineAt: 1_800_000_000_000 };

beforeEach(() => {
  h.runModelTask.mockReset();
  h.runModelTask.mockResolvedValue({ outputs: [{ kind: "url", url: "https://cdn/out.mp4" }], costs: [], servedBy: "wavespeed" });
});

describe("a model mini-tool", () => {
  it("runs on the pinned model, under the tool's modality, writing the tool's outputs", async () => {
    const params = { prompt: "keep going", model: "some-other-model", video: "https://cdn/x.mp4" };

    await runMiniTool({ toolId: "video.extend", params, ...RUN });

    expect(h.runModelTask).toHaveBeenCalledExactlyOnceWith({
      taskId: "task-1",
      modality: "video",
      model: "seedance-2.5-video-extend",
      params,
      projectId: "p1",
      outputCount: 1,
      deadlineAt: RUN.deadlineAt,
    });
  });

  it("hands on what the run produced, the model it ran on and who served it", async () => {
    const run = await runMiniTool({ toolId: "image.remove-bg", params: {}, ...RUN });

    expect(run).toEqual({ result: { outputs: [{ url: "https://cdn/out.mp4" }], model: "bria-remove-background" }, credits: 0, pending: [], servedBy: "wavespeed" });
  });
});
