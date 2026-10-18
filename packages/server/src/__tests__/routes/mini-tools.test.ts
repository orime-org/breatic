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
import { assetRepo, modelCatalog } from "@breatic/domain";
import { miniToolById } from "@breatic/shared/mini-tools";

import { createApp } from "../../app.js";
import { mocks, mockQueueAdd } from "../helpers/mock-core.js";

// The run-once routes need a key per press; the Redis double in mock-core
// answers every claim as a first press, so one key serves the whole file.
const AUTH = {
  Cookie: "breatic_session=valid-token",
  "Content-Type": "application/json",
  "Idempotency-Key": "test-press",
};
const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-9222-222222222222";
const NODE_A = "33333333-3333-4333-8333-333333333333";
const NODE_B = "44444444-4444-4444-8444-444444444444";
const OURS = "https://assets.example.com/v/abc.mp4";

const CRYSTAL = {
  name: "pro-upscaler",
  takes_prompt: false,
  params: {
    image: { fill: "tool", accepts: "image" },
    target_megapixels: { fill: "tool", default: 4, min: 1, max: 1500 },
    creativity: { fill: "tool", default: 0, min: 0, max: 10 },
  },
};
const GENFILL = {
  name: "bria-genfill",
  takes_prompt: true,
  params: { image: { fill: "tool", accepts: "image" }, mask_image: { fill: "tool", accepts: "image" } },
};
const SEEDREAM = {
  name: "seedream-v4.5-edit",
  takes_prompt: true,
  params: { images: { fill: "tool", accepts: "image", type: "list", max_items: 1 } },
};
const LIST_IMAGES = { fill: "tool", accepts: "image", type: "list", max_items: 1 };
const RELIGHT = {
  name: "nano-banana-2-relight",
  takes_prompt: true,
  params: {
    images: LIST_IMAGES,
    light_reference: { fill: "tool", accepts: "image", optional: true },
    aspect_ratio: { fill: "none", values: ["auto", "1:1", "2:3", "3:2", "16:9"], absent_value: "auto" },
  },
};
const RESTYLE = {
  name: "gpt-image-2.5-sunburst-edit",
  takes_prompt: true,
  params: {
    images: { ...LIST_IMAGES, max_items: 4 },
    style_images: { fill: "canvas", accepts: "image", type: "list", max_items: 3, optional: true },
  },
};
const QUICK_EDIT = { name: "nano-banana-2-quick-edit", takes_prompt: true, params: { images: LIST_IMAGES } };
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
    mocks.creditHoldService.reserveCredits.mockReset();
    mocks.creditHoldService.reserveCredits.mockResolvedValue({ ok: true });
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
      image: [CRYSTAL, GENFILL, SEEDREAM, RELIGHT, RESTYLE, QUICK_EDIT],
      video: [],
      audio: [VOCALS],
      tts: [],
      three_d: [],
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
    expect(mocks.taskService.create.mock.calls[0]?.[6]).toBe("pro-upscaler");
    expect(mocks.taskService.create.mock.calls[0]?.[7]).toBe("mini_tool");
    expect(mocks.nodeTaskService.open).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: NODE_A, action: "mini_tool", label: "image.upscale" }),
    );
  });

  // inner#1302: what the reader drew reaches the pinned model through the task's params.
  it("sends the drawn mask and the node's own source to the inpaint model", async () => {
    const res = await post({
      tool: "image.inpaint",
      node_ids: [NODE_A],
      source: { url: "https://assets.example.com/i/a.png" },
      prompt: "a red bow tie",
      drawing: { mask: "https://assets.example.com/i/mask.png" },
    });

    expect(res.status).toBe(201);
    expect(mocks.taskService.create.mock.calls[0]?.[6]).toBe("bria-genfill");
    expect(mocks.taskService.create.mock.calls[0]?.[5]).toMatchObject({
      image: "https://assets.example.com/i/a.png",
      mask_image: "https://assets.example.com/i/mask.png",
      prompt: "a red bow tie",
    });
  });

  it("sends the padded picture and the mask of its new area to the fill model", async () => {
    const res = await post({
      tool: "image.expand",
      node_ids: [NODE_A],
      source: { url: "https://assets.example.com/i/a.png" },
      prompt: "a beach at dusk",
      expand: { image: "https://assets.example.com/i/padded.png", mask: "https://assets.example.com/i/mask.png" },
    });

    expect(res.status).toBe(201);
    expect(mocks.taskService.create.mock.calls[0]?.[6]).toBe("bria-genfill");
    expect(mocks.taskService.create.mock.calls[0]?.[5]).toMatchObject({
      image: "https://assets.example.com/i/padded.png",
      mask_image: "https://assets.example.com/i/mask.png",
      prompt: "a beach at dusk",
    });
  });

  it("fills an empty expand prompt with the tool's own and records it on the task", async () => {
    await post({
      tool: "image.expand",
      node_ids: [NODE_A],
      source: { url: "https://assets.example.com/i/a.png" },
      prompt: "  ",
      expand: { image: "https://assets.example.com/i/padded.png", mask: "https://assets.example.com/i/mask.png" },
    });

    expect(mocks.taskService.create.mock.calls[0]?.[5]).toMatchObject({
      prompt: miniToolById("image.expand")?.prompt?.defaultText,
    });
  });

  // inner#1304: the restyle prefix always goes; what the reader wrote follows it.
  it("sends the restyle prefix alone, or with the reader's words after it", async () => {
    const preamble = miniToolById("image.restyle")?.prompt?.preamble;
    const run = (prompt: string): Promise<Response> =>
      post({
        tool: "image.restyle",
        node_ids: [NODE_A],
        source: { url: "https://assets.example.com/i/a.png" },
        prompt,
        slots: { style: [{ url: "https://assets.example.com/i/s.png" }] },
      });
    await run(" ");
    await run("thick brush strokes");
    expect(mocks.taskService.create.mock.calls[0]?.[5]).toMatchObject({ prompt: preamble });
    expect(mocks.taskService.create.mock.calls[1]?.[5]).toMatchObject({
      prompt: `${preamble} Also: thick brush strokes`,
    });
  });

  it("sends an empty relight note as it is", async () => {
    await post({
      tool: "image.relight",
      node_ids: [NODE_A],
      source: { url: "https://assets.example.com/i/a.png", width: 768, height: 1152 },
      prompt: "",
    });
    expect(mocks.taskService.create.mock.calls[0]?.[5]).toMatchObject({ prompt: "" });
  });

  it("records the catalog ratio nearest the source's size on a relight run", async () => {
    await post({
      tool: "image.relight",
      node_ids: [NODE_A],
      source: { url: "https://assets.example.com/i/a.png", width: 768, height: 1152 },
    });
    await post({ tool: "image.relight", node_ids: [NODE_A], source: { url: "https://assets.example.com/i/a.png" } });
    expect(mocks.taskService.create.mock.calls[0]?.[5]).toMatchObject({ aspect_ratio: "2:3" });
    expect(mocks.taskService.create.mock.calls[1]?.[5]).toMatchObject({ aspect_ratio: "auto" });
  });

  it("records no ratio on a tool that does not declare one", async () => {
    await post({
      tool: "image.quickEdit",
      node_ids: [NODE_A],
      source: { url: "https://assets.example.com/i/a.png", width: 768, height: 1152 },
      prompt: "make it night",
    });
    expect(mocks.taskService.create.mock.calls[0]?.[5]).not.toHaveProperty("aspect_ratio");
  });

  it("refuses an expand run that carries no padded picture, before any row opens", async () => {
    const res = await post({
      tool: "image.expand",
      node_ids: [NODE_A],
      source: { url: "https://assets.example.com/i/a.png" },
      prompt: "",
    });

    expect(res.status).toBe(422);
    expect(mocks.taskService.create).not.toHaveBeenCalled();
  });

  it("sends the sketch composite as the only image in the list", async () => {
    await post({
      tool: "image.sketch",
      node_ids: [NODE_A],
      source: { url: "https://assets.example.com/i/a.png" },
      prompt: "a party hat",
      drawing: { image: "https://assets.example.com/i/sketch.png" },
    });

    expect(mocks.taskService.create.mock.calls[0]?.[5]).toMatchObject({
      images: ["https://assets.example.com/i/sketch.png"],
    });
  });

  it("refuses a drawing tool's run that carries no drawing, before any row opens", async () => {
    const res = await post({
      tool: "image.erase",
      node_ids: [NODE_A],
      source: { url: "https://assets.example.com/i/a.png" },
    });

    expect(res.status).toBe(422);
    expect(mocks.taskService.create).not.toHaveBeenCalled();
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
    mocks.creditHoldService.reserveCredits.mockResolvedValue({ ok: false, studioId: "s1", spendable: 0, held: 0, available: 0 });
    const res = await post({
      tool: "image.upscale",
      node_ids: [NODE_A],
      source: { url: "https://assets.example.com/i/a.png" },
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { task_id: "task-1", status: "failed" } });
    expect(mocks.taskService.markFailed).toHaveBeenCalledWith("task-1", "no_credits");
  });

  it("settles the opened rows as credits_held when running work holds what the run needs", async () => {
    mocks.creditHoldService.reserveCredits.mockResolvedValue({ ok: false, studioId: "s1", spendable: 100, held: 90, available: 10 });
    const res = await post({
      tool: "image.upscale",
      node_ids: [NODE_A],
      source: { url: "https://assets.example.com/i/a.png" },
    });

    expect(res.status).toBe(201);
    expect(mocks.taskService.markFailed).toHaveBeenCalledWith("task-1", "credits_held");
  });

  it("still settles the rows as credits_held when the caller has unassigned credits to point at", async () => {
    mocks.creditHoldService.reserveCredits.mockResolvedValue({ ok: false, studioId: "s1", spendable: 100, held: 90, available: 10 });
    mocks.creditLotService.getUnassignedCredits.mockResolvedValueOnce(50);
    await post({
      tool: "image.upscale",
      node_ids: [NODE_A],
      source: { url: "https://assets.example.com/i/a.png" },
    });

    expect(mocks.taskService.markFailed).toHaveBeenCalledWith("task-1", "credits_held");
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

  // Every container operation reads a video; another file in the bucket is
  // only reachable by a forged request.
  it("refuses a container source our bucket files as something other than a video", async () => {
    for (const kind of ["image", null]) {
      vi.mocked(assetRepo.findKindByStorageKey).mockResolvedValueOnce(kind);
      const res = await post({
        tool: "video.cut",
        node_ids: [NODE_A],
        source: { url: OURS, duration: 8 },
        params: { range: { start: 0, end: 2 } },
      });
      expect(res.status, String(kind)).toBe(400);
    }
    expect(vi.mocked(assetRepo.findKindByStorageKey)).toHaveBeenCalledWith("v/abc.mp4");
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
      tts: [],
      three_d: [],
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
    expect(mocks.creditHoldService.reserveCredits).not.toHaveBeenCalled();
    expect(mocks.taskService.create).not.toHaveBeenCalled();
    expect(mocks.nodeTaskService.open).not.toHaveBeenCalled();
  });
});
