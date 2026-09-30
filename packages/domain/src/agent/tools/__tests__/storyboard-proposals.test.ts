// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the agent learns about a model's storyboard, and what it may propose
 * with one (#2218).
 *
 * The storyboard params are filled from the node's storyboard, not typed in
 * `params`, so the agent reaches them only through a proposal's `storyboard`
 * and `shots`. The listing has to say so, and the check has to hold shots to
 * the same rules the panel's execute gate holds them to.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { CanvasProposal, ProposalNode } from "@breatic/shared";

import {
  generationModels,
  renderGenerationModelsForModel,
  type PricedModelsForMode,
} from "@domain/agent/tools/generation-models.js";
import { checkProposal } from "@domain/agent/tools/propose-canvas-action.js";
import {
  allProviderKeyNames,
  restoreProcessEnv,
  useEnvWithKeys,
} from "@domain/model-catalog/__tests__/catalog-env.js";

beforeEach(() => {
  restoreProcessEnv();
  useEnvWithKeys(allProviderKeyNames());
});

afterAll(() => {
  restoreProcessEnv();
});

const KLING = "kling-v3.0-4k-text-to-video";

/**
 * Runs a tool the way the SDK does.
 * @param canvasTool - The tool.
 * @param input - Its input.
 * @returns Its answer.
 */
async function run<T>(canvasTool: unknown, input: unknown): Promise<T> {
  const execute = (canvasTool as { execute: (i: unknown, o: object) => Promise<T> }).execute;
  return execute(input, {});
}

/**
 * A lone text-to-video generation.
 * @param node - What to put on the node beside its role and type.
 * @returns The proposal.
 */
function alone(node: Partial<ProposalNode>): CanvasProposal {
  return {
    nodes: [{ role: "generate", type: "video", name: "The clip", mode: "t2v", model: KLING, params: { duration: 5 }, ...node }],
    edges: [],
    modelNote: "",
    rationale: "",
    groupName: "Clip",
  };
}

const twoShots = [
  { prompt: [{ text: "a paper boat, close-up" }], duration: 2 },
  { prompt: [{ text: "the pond at dusk" }], duration: 3 },
];

describe("the model listing", () => {
  it("says which model takes a storyboard, and how", async () => {
    const answer = await run<PricedModelsForMode>(generationModels, { nodeType: "video", mode: "t2v" });
    const line = renderGenerationModelsForModel(answer).split("\n").find((l) => l.includes(`(${KLING})`)) ?? "";
    expect(line).toMatch(/storyboard/i);
    expect(line).toMatch(/at most 6 shots/);
    expect(line).toMatch(/512 characters/);
  });

  it("does not call the storyboard params unreachable", async () => {
    const answer = await run<PricedModelsForMode>(generationModels, { nodeType: "video", mode: "t2v" });
    const rendered = renderGenerationModelsForModel(answer);
    expect(rendered).not.toMatch(/Nothing here reaches:[^\n]*multi_prompt/);
    expect(rendered).not.toMatch(/multi_prompt: this panel draws no control/);
  });
});

describe("a proposal with a storyboard", () => {
  it("takes shots with no main prompt", () => {
    expect(checkProposal(alone({ prompt: undefined, shots: twoShots }))).toEqual({ ok: true });
  });

  it("takes the automatic tier with a main prompt", () => {
    expect(checkProposal(alone({ prompt: [{ text: "a boat, then the pond" }], storyboard: "auto" }))).toEqual({ ok: true });
  });

  it("refuses shots whose seconds do not add up to the duration", () => {
    const answer = checkProposal(alone({ prompt: undefined, shots: twoShots, params: { duration: 4 } }));
    expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/add up to 5 seconds and duration is 4/) });
  });

  it("refuses an empty shot", () => {
    const answer = checkProposal(alone({ prompt: undefined, shots: [twoShots[0]!, { prompt: [], duration: 3 }] }));
    expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/Shot 2 writes nothing/) });
  });

  it("refuses both tiers at once", () => {
    const answer = checkProposal(alone({ prompt: undefined, shots: twoShots, storyboard: "auto" }));
    expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/not both/) });
  });

  it("refuses shots on a model that takes no storyboard", () => {
    const answer = checkProposal(
      alone({ model: "minimax-h3-text-to-video", prompt: undefined, shots: twoShots, params: {} }),
    );
    expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/takes no storyboard/) });
  });

  it("refuses the storyboard params written into params", () => {
    const answer = checkProposal(
      alone({ prompt: [{ text: "a boat" }], params: { duration: 5, shot_type: "customize" } }),
    );
    expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/set by the node's storyboard/) });
  });

  it("refuses shots or a storyboard on a node that does not generate", () => {
    const source = {
      nodes: [{ role: "source", type: "image", name: "Your photo", shots: twoShots }],
      edges: [],
      modelNote: "",
      rationale: "",
      groupName: "Clip",
    } as unknown as CanvasProposal;
    expect(checkProposal(source)).toMatchObject({ ok: false, reason: expect.stringMatching(/storyboard/) });
    const written = {
      nodes: [{ role: "written", type: "text", name: "Copy", prompt: [{ text: "hi" }], storyboard: "auto" }],
      edges: [],
      modelNote: "",
      rationale: "",
      groupName: "Clip",
    } as unknown as CanvasProposal;
    expect(checkProposal(written)).toMatchObject({ ok: false });
  });
});
