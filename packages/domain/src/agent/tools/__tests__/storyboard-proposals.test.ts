// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the agent learns about the multi-shot mode, and what it may propose in
 * it.
 *
 * The shot params are filled from the node's shots, not typed in `params`, so
 * the agent reaches them only through a proposal's `shots`, and only in the
 * multi-shot mode. The listing has to say so, and the check has to hold shots
 * to the same rules the panel's execute gate holds them to.
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
 * A lone multi-shot generation.
 * @param node - What to put on the node beside its role and type.
 * @returns The proposal.
 */
function alone(node: Partial<ProposalNode>): CanvasProposal {
  return {
    nodes: [
      { role: "generate", type: "video", name: "The clip", mode: "multi_shot", model: KLING, params: { duration: 5 }, ...node },
    ],
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
  it("says in the multi-shot mode that a model takes shots, and how many", async () => {
    const answer = await run<PricedModelsForMode>(generationModels, { nodeType: "video", mode: "multi_shot" });
    const line = renderGenerationModelsForModel(answer).split("\n").find((l) => l.includes(`(${KLING})`)) ?? "";
    expect(line).toMatch(/shots/);
    expect(line).toMatch(/at most 6 shots/);
    expect(line).toMatch(/512 characters/);
  });

  it("names each model as the mode's picker shows it", async () => {
    const multiShot = renderGenerationModelsForModel(
      await run<PricedModelsForMode>(generationModels, { nodeType: "video", mode: "multi_shot" }),
    );
    expect(multiShot).toContain("- Gemini Omni 1.1 Flash Reference (gemini-omni-1.1-flash-reference-to-video)");
    const ref = renderGenerationModelsForModel(
      await run<PricedModelsForMode>(generationModels, { nodeType: "video", mode: "ref" }),
    );
    expect(ref).toContain("- Gemini Omni 1.1 Flash (gemini-omni-1.1-flash-reference-to-video)");
  });

  it("says nothing about shots outside the multi-shot mode", async () => {
    const answer = await run<PricedModelsForMode>(generationModels, { nodeType: "video", mode: "t2v" });
    const line = renderGenerationModelsForModel(answer).split("\n").find((l) => l.includes(`(${KLING})`)) ?? "";
    expect(line).not.toMatch(/shots \(/);
  });

  it("does not call the shot params unreachable", async () => {
    const answer = await run<PricedModelsForMode>(generationModels, { nodeType: "video", mode: "multi_shot" });
    const rendered = renderGenerationModelsForModel(answer);
    expect(rendered).not.toMatch(/Nothing here reaches:[^\n]*multi_prompt/);
    expect(rendered).not.toMatch(/multi_prompt: this panel draws no control/);
  });
});

describe("a multi-shot proposal", () => {
  it("takes shots with no main prompt", () => {
    expect(checkProposal(alone({ prompt: undefined, shots: twoShots }))).toEqual({ ok: true });
  });

  it("takes shots on a model that has them written into its prompt", () => {
    expect(
      checkProposal(alone({ model: "wan-3.0-text-to-video", prompt: undefined, shots: twoShots })),
    ).toEqual({ ok: true });
  });

  it("refuses the mode without shots", () => {
    const answer = checkProposal(alone({ prompt: [{ text: "a boat, then the pond" }] }));
    expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/multi_shot.*shots/) });
  });

  it("refuses shots in any other mode", () => {
    const answer = checkProposal(alone({ mode: "t2v", prompt: undefined, shots: twoShots }));
    expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/multi_shot/) });
  });

  it("refuses shots whose seconds do not add up to the duration", () => {
    const answer = checkProposal(alone({ prompt: undefined, shots: twoShots, params: { duration: 4 } }));
    expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/add up to 5 seconds and duration is 4/) });
  });

  it("refuses an empty shot", () => {
    const answer = checkProposal(alone({ prompt: undefined, shots: [twoShots[0]!, { prompt: [], duration: 3 }] }));
    expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/Shot 2 writes nothing/) });
  });

  it("refuses more than six shots, whatever the model allows", () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ prompt: [{ text: `shot ${i + 1}` }], duration: 1 }));
    const answer = checkProposal(
      alone({ model: "wan-3.0-text-to-video", prompt: undefined, shots: seven, params: { duration: 7 } }),
    );
    expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/at most 6 shots/) });
  });

  it("refuses a main prompt beside shots, which the run would not send", () => {
    const answer = checkProposal(alone({ prompt: [{ text: "the whole film" }], shots: twoShots }));
    expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/main prompt is not sent/) });
  });

  it("refuses the shot params written into params", () => {
    const answer = checkProposal(alone({ prompt: undefined, shots: twoShots, params: { duration: 5, shot_type: "customize" } }));
    expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/set by the node's shots/) });
  });

  it("takes auto multi-shot as an ordinary param in text-to-video", () => {
    expect(
      checkProposal(alone({ mode: "t2v", prompt: [{ text: "a boat, then the pond" }], params: { duration: 5, auto_shots: true } })),
    ).toEqual({ ok: true });
  });

  it("refuses shots on a node that does not generate", () => {
    const source = {
      nodes: [{ role: "source", type: "image", name: "Your photo", shots: twoShots }],
      edges: [],
      modelNote: "",
      rationale: "",
      groupName: "Clip",
    } as unknown as CanvasProposal;
    expect(checkProposal(source)).toMatchObject({ ok: false, reason: expect.stringMatching(/shots/) });
  });
});
