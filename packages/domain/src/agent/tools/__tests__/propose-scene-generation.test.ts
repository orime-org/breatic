// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * `propose_scene_generation` (inner#1691 design 6.1): a 3D generation the
 * agent proposes, bound to no Space, checked the way the submit route checks
 * it (design 4.2 steps 2 to 4) and answered with what the card draws. The
 * user opens it in whichever 3D Space is in front. A proposal creates no task
 * and holds no credits; nothing runs until the user presses Generate in the
 * dialog it opens.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@breatic/core";
import { resolveParams, type ModelEntry } from "@breatic/shared";

import { TOOL_MAP } from "@domain/agent/tools/index.js";
import { makeProposeSceneGeneration } from "@domain/agent/tools/propose-scene-generation.js";
import { getModelCatalog, estimateModelCredits } from "@domain/model-catalog/model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";
import { resolveProjectImageInputs } from "@domain/asset/project-image-inputs.js";
import * as creditHoldService from "@domain/credit/creditHold.service.js";
import * as taskService from "@domain/task/task.service.js";
import * as sceneTaskService from "@domain/node-task/scene-task.service.js";

vi.mock("@domain/asset/project-image-inputs.js", () => ({ resolveProjectImageInputs: vi.fn() }));

vi.mock("@domain/credit/creditHold.service.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reserveCredits: vi.fn(),
}));

vi.mock("@domain/task/task.service.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  create: vi.fn(),
}));

vi.mock("@domain/node-task/scene-task.service.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  open: vi.fn(),
  openGeneration: vi.fn(),
}));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "22222222-2222-4222-8222-222222222222";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What the turn hands the tool: only the project, to resolve images in. */
const CONTEXT = { projectId: PROJECT_ID };

/** The tool's answer, as far as these cases read it. */
type Answer =
  | ({ placed: true } & Record<string, unknown>)
  | { placed: false; reason: string };

beforeEach(() => {
  restoreProcessEnv();
  useFullCatalog();
  vi.mocked(resolveProjectImageInputs).mockReset();
  vi.mocked(creditHoldService.reserveCredits).mockReset();
  vi.mocked(taskService.create).mockReset();
});

afterAll(() => {
  restoreProcessEnv();
});

/**
 * Run the tool the way a turn does, with this turn's context.
 * @param input - What the agent sent.
 * @returns The tool's answer.
 */
async function propose(input: Record<string, unknown>): Promise<Answer> {
  const tool = makeProposeSceneGeneration();
  const execute = (tool as unknown as {
    execute: (i: unknown, o: { toolCallId: string; messages: unknown[]; context: unknown }) => Promise<Answer>;
  }).execute;
  return execute(input, { toolCallId: "c1", messages: [], context: CONTEXT });
}

/**
 * Why a proposal was refused.
 * @param input - What the agent sent.
 * @returns The reason.
 * @throws {Error} When the proposal was placed.
 */
async function refusal(input: Record<string, unknown>): Promise<string> {
  const answer = await propose(input);
  if (answer.placed) throw new Error(`expected a refusal, got ${JSON.stringify(answer)}`);
  return answer.reason;
}

/**
 * One 3D catalog entry.
 * @param name - The entry name.
 * @returns The entry.
 * @throws {Error} When the 3D catalog does not carry it.
 */
function threeDEntry(name: string): ModelEntry {
  const entry = getModelCatalog().three_d.find((e) => e.name === name);
  if (entry === undefined) throw new Error(`the 3D catalog carries no ${name}`);
  return entry;
}

/** A text-to-3D proposal that holds together. */
const TEXT_TO_3D = {
  mode: "t23d",
  model: "tripo-h3.1-t23d",
  prompt: "a red fox sitting",
  params: { texture_quality: "detailed", smart_low_poly: true, negative_prompt: "blurry" },
  rationale: "A fox prop for the scene.",
};

/**
 * Resolved images, as the shared resolver hands them back.
 * @param ids - The asset ids in view order.
 * @returns One resolved image per id.
 */
function resolvedImages(ids: string[]): Array<{ assetId: string; url: string; displayName: string }> {
  return ids.map((id) => ({ assetId: id, url: `https://cdn.example.test/${id}.png`, displayName: `${id}.png` }));
}

describe("no Space", () => {
  it("is not an input the tool declares: a spaceId is refused or dropped by the input check", () => {
    const schema = (makeProposeSceneGeneration() as unknown as {
      inputSchema: { safeParse: (v: unknown) => { success: boolean; data?: Record<string, unknown> } };
    }).inputSchema;
    const parsed = schema.safeParse({ ...TEXT_TO_3D, spaceId: SPACE_ID });
    if (parsed.success) expect(parsed.data).not.toHaveProperty("spaceId");
    expect(schema.safeParse(TEXT_TO_3D).success).toBe(true);
  });

  it("never answers with a Space, even when the agent sent one", async () => {
    const answer = await propose({ ...TEXT_TO_3D, spaceId: SPACE_ID });
    expect(answer).not.toHaveProperty("spaceId");
    expect(answer).not.toHaveProperty("spaceName");
  });
});

describe("the model and mode", () => {
  it("is refused when the model is not in the 3D catalog", async () => {
    expect(await refusal({ ...TEXT_TO_3D, model: "nano-banana-2" })).toContain("nano-banana-2");
  });

  it("is refused when the model does not serve the mode, naming both", async () => {
    const reason = await refusal({ ...TEXT_TO_3D, model: "tripo-h3.1-i23d" });
    expect(reason).toContain("tripo-h3.1-i23d");
    expect(reason).toContain("t23d");
  });
});

describe("the number of images", () => {
  const IMAGE_TO_3D = { mode: "i23d", params: {}, rationale: "A fox prop from the sketch." };

  it("is refused when the single image entry gets two", async () => {
    vi.mocked(resolveProjectImageInputs).mockResolvedValue(resolvedImages(["a1", "a2"]));
    const reason = await refusal({ ...IMAGE_TO_3D, model: "tripo-h3.1-i23d", images: ["a1", "a2"] });
    expect(reason).toContain("tripo-h3.1-i23d");
    expect(reason).toMatch(/\b2\b/);
  });

  it.each([[["a1"]], [["a1", "a2", "a3", "a4", "a5"]]])("is refused when the multi-view entry gets %j", async (images) => {
    vi.mocked(resolveProjectImageInputs).mockResolvedValue(resolvedImages(images));
    const reason = await refusal({ ...IMAGE_TO_3D, model: "tripo-h3.1-multiview", images });
    expect(reason).toContain("tripo-h3.1-multiview");
    // The rule: two to four views.
    expect(reason).toMatch(/\b2\b/);
    expect(reason).toMatch(/\b4\b/);
  });
});

describe("the images", () => {
  const MULTI_VIEW = {
    mode: "i23d",
    model: "tripo-h3.1-multiview",
    params: {},
    images: ["https://cdn.example.test/front.png", "a-left"],
    rationale: "A fox prop from two views.",
  };

  it("are resolved in view order against this turn's project", async () => {
    vi.mocked(resolveProjectImageInputs).mockResolvedValue(resolvedImages(["a-front", "a-left"]));
    const answer = await propose(MULTI_VIEW);
    expect(resolveProjectImageInputs).toHaveBeenCalledWith(PROJECT_ID, ["https://cdn.example.test/front.png", "a-left"]);
    expect(answer).toMatchObject({
      placed: true,
      images: [
        expect.objectContaining({ assetId: "a-front", url: "https://cdn.example.test/a-front.png" }),
        expect.objectContaining({ assetId: "a-left", url: "https://cdn.example.test/a-left.png" }),
      ],
    });
  });

  it("are refused with the resolver's reason, which names the view slot, when one does not resolve", async () => {
    const said = "View slot 1 (front): no image registered at https://cdn.example.test/front.png in this project.";
    vi.mocked(resolveProjectImageInputs).mockRejectedValue(new AppError(422, said));
    expect(await refusal(MULTI_VIEW)).toContain(said);
  });

  it("are refused when a view is a video asset, naming the view slot", async () => {
    const said = "View slot 2 (left): asset a-left is a video, not an image.";
    vi.mocked(resolveProjectImageInputs).mockRejectedValue(new AppError(422, said));
    expect(await refusal(MULTI_VIEW)).toContain(said);
  });
});

describe("a setting a forced value overrides", () => {
  it("is refused naming pbr_needs_texture when texture is off and pbr is left to its default", async () => {
    expect(await refusal({ ...TEXT_TO_3D, params: { texture: false } })).toContain("pbr_needs_texture");
  });

  it("is refused naming parts_geometry_only when separate parts asks for a texture", async () => {
    expect(await refusal({ ...TEXT_TO_3D, params: { generate_parts: true, texture: true } })).toContain("parts_geometry_only");
  });
});

describe("a text-to-3D proposal that holds together", () => {
  it("answers with what the card draws: resolved settings and the estimate for them", async () => {
    const entry = threeDEntry("tripo-h3.1-t23d");
    const params = resolveParams(entry, TEXT_TO_3D.params);
    const estimate = await estimateModelCredits("tripo-h3.1-t23d", { params });
    if (estimate === undefined) throw new Error("tripo-h3.1-t23d carries no price");

    const answer = await propose(TEXT_TO_3D);

    expect(params).toMatchObject({ negative_prompt: "blurry" });
    expect(answer).toEqual({
      placed: true,
      proposalId: expect.stringMatching(UUID),
      mode: "t23d",
      model: "tripo-h3.1-t23d",
      prompt: "a red fox sitting",
      params,
      images: [],
      credits: estimate.credits,
      rationale: "A fox prop for the scene.",
    });
  });

  it("creates no task, holds no credits and opens no Space task row", async () => {
    const answer = await propose(TEXT_TO_3D);
    expect(answer.placed).toBe(true);
    expect(taskService.create).not.toHaveBeenCalled();
    expect(creditHoldService.reserveCredits).not.toHaveBeenCalled();
    expect(sceneTaskService.open).not.toHaveBeenCalled();
    expect((sceneTaskService as unknown as { openGeneration: unknown }).openGeneration).not.toHaveBeenCalled();
  });

  it("gives each proposal its own id", async () => {
    const [a, b] = await Promise.all([propose(TEXT_TO_3D), propose(TEXT_TO_3D)]);
    expect(a.placed && b.placed).toBe(true);
    expect((a as { proposalId?: unknown }).proposalId).not.toBe((b as { proposalId?: unknown }).proposalId);
  });
});

describe("registration", () => {
  it("is registered as propose_scene_generation", () => {
    const build = TOOL_MAP["propose_scene_generation"];
    expect(typeof build).toBe("function");
  });
});
