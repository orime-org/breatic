// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `POST /api/v1/mini-tools` — the one entry every server-run tool shares.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(), generateText: vi.fn(), stepCountIs: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  return coreMock(importOriginal);
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  return domainMock();
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});

import { ForbiddenError } from "@breatic/core";
import { modelCatalog } from "@breatic/domain";

import { createApp } from "../../app.js";
import { mocks, mockQueueAdd } from "../helpers/mock-core.js";

const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json" };
const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-9222-222222222222";
const NODE_A = "33333333-3333-4333-8333-333333333333";
const NODE_B = "44444444-4444-4444-8444-444444444444";
const OURS = "https://assets.example.com/v/abc.mp4";

const CRYSTAL = {
  name: "crystal-upscaler",
  takes_prompt: false,
  params: {
    image: { fill: "tool", accepts: "image" },
    target_megapixels: { fill: "tool", default: 4, min: 1, max: 1500 },
    creativity: { fill: "tool", default: 0, min: 0, max: 10 },
  },
};
const VOCALS = {
  name: "vocal-remover",
  takes_prompt: false,
  params: { audio: { fill: "tool", accepts: "audio" } },
};

/**
 * Post one mini-tool request.
 * @param body - The request body.
 * @returns The response.
 */
async function post(body: Record<string, unknown>): Promise<Response> {
  return createApp().request("/api/v1/mini-tools", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ project_id: PID, space_id: SID, slots: {}, params: {}, ...body }),
  });
}

describe("POST /mini-tools", () => {
  beforeEach(() => {
    mocks.creditLotService.getSpendableCredits.mockReset();
    mocks.creditLotService.getSpendableCredits.mockResolvedValue(100);
    mocks.taskService.create.mockReset();
    mocks.taskService.create.mockResolvedValue({ id: "task-1", taskType: "image" });
    mocks.taskService.markFailed.mockReset();
    mocks.nodeTaskService.open.mockClear();
    mocks.projectService.assertAccess.mockReset();
    mockQueueAdd.mockReset();
    mockQueueAdd.mockResolvedValue({ id: "job-1" });
    mocks.getStorageAdapter.mockResolvedValue({
      keyFromUrl: (url: string) => (url.startsWith("https://assets.example.com/") ? url.slice(27) : null),
    });
    vi.mocked(modelCatalog.getModelCatalog).mockReturnValue({
      image: [CRYSTAL],
      video: [],
      audio: [VOCALS],
    } as never);
  });

  it("opens a mini_tool row on the new node and queues the run on the pinned model", async () => {
    const res = await post({
      tool: "image.upscale",
      node_ids: [NODE_A],
      source: { url: "https://assets.example.com/i/a.png" },
      params: { target_megapixels: 16, creativity: 2 },
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { task_id: "task-1", status: "pending" } });
    expect(mocks.taskService.create.mock.calls[0]?.[6]).toBe("crystal-upscaler");
    expect(mocks.taskService.create.mock.calls[0]?.[8]).toBe("mini_tool");
    expect(mocks.nodeTaskService.open).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: NODE_A, action: "mini_tool", label: "image.upscale" }),
    );
  });

  it("opens one row per output for vocal separation", async () => {
    await post({
      tool: "audio.separate",
      node_ids: [NODE_A, NODE_B],
      source: { url: "https://assets.example.com/a/s.mp3", duration: 30 },
    });

    expect(mocks.nodeTaskService.open).toHaveBeenCalledTimes(2);
  });

  it("settles the opened rows as no_credits when the balance is short", async () => {
    mocks.creditLotService.getSpendableCredits.mockResolvedValue(0);
    const res = await post({
      tool: "image.upscale",
      node_ids: [NODE_A],
      source: { url: "https://assets.example.com/i/a.png" },
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { task_id: "task-1", status: "failed" } });
    expect(mocks.taskService.markFailed).toHaveBeenCalledWith("task-1", "no_credits");
  });

  it("refuses a param the tool does not expose, before any row opens", async () => {
    const res = await post({
      tool: "image.upscale",
      node_ids: [NODE_A],
      source: { url: "https://assets.example.com/i/a.png" },
      params: { model: "some-other-model" },
    });

    expect(res.status).toBe(422);
    expect(mocks.taskService.create).not.toHaveBeenCalled();
  });

  it("refuses a value outside the pinned model's range", async () => {
    const res = await post({
      tool: "image.upscale",
      node_ids: [NODE_A],
      source: { url: "https://assets.example.com/i/a.png" },
      params: { creativity: 99 },
    });

    expect(res.status).toBe(400);
    expect(mocks.taskService.create).not.toHaveBeenCalled();
  });

  it("refuses a container source that is not one of our addresses", async () => {
    const res = await post({
      tool: "video.cut",
      node_ids: [NODE_A],
      source: { url: "https://elsewhere.example.org/v.mp4" },
      params: { range: { start: 0, end: 2 } },
    });

    expect(res.status).toBe(400);
    expect(mocks.taskService.create).not.toHaveBeenCalled();
  });

  it("accepts a container source in our bucket whatever studio filed it", async () => {
    const res = await post({
      tool: "video.cut",
      node_ids: [NODE_A],
      source: { url: OURS, duration: 8 },
      params: { range: { start: 0, end: 2 } },
    });

    expect(res.status).toBe(201);
  });

  it("answers 503 when the pinned model is not served", async () => {
    vi.mocked(modelCatalog.getModelCatalog).mockReturnValue({
      image: [],
      video: [],
      audio: [],
    } as never);
    const res = await post({
      tool: "image.upscale",
      node_ids: [NODE_A],
      source: { url: "https://assets.example.com/i/a.png" },
    });

    expect(res.status).toBe(503);
    expect(mocks.taskService.create).not.toHaveBeenCalled();
  });

  it("refuses a browser tool, which never reaches the server", async () => {
    const res = await post({
      tool: "image.crop",
      node_ids: [NODE_A],
      source: { url: "https://assets.example.com/i/a.png" },
    });

    expect(res.status).toBe(422);
  });

  it("refuses a caller below editor on the project, before spending or opening a row", async () => {
    mocks.projectService.assertAccess.mockRejectedValue(new ForbiddenError("forbidden"));
    const res = await post({
      tool: "image.upscale",
      node_ids: [NODE_A],
      source: { url: "https://assets.example.com/i/a.png" },
    });

    expect(res.status).toBe(403);
    expect(mocks.projectService.assertAccess).toHaveBeenCalledWith(PID, "user-1", "editor");
    expect(mocks.creditLotService.getSpendableCredits).not.toHaveBeenCalled();
    expect(mocks.taskService.create).not.toHaveBeenCalled();
    expect(mocks.nodeTaskService.open).not.toHaveBeenCalled();
  });
});
