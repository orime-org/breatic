// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Swap the catalog and every answer follows, with no code changed (#269).
 *
 * This is the whole point stated as one test. The catalog below differs from
 * the repository's in four ways a deployment could plausibly differ: a model
 * spells its picture `portrait`, its mode takes any one of the two slots it
 * offers rather than both, one of its controls waits on that picture, and
 * there is a mode nothing in this repository has ever heard of.
 *
 * Three of the four consumers run here: the pre-enqueue gate, the proposal
 * tool, and the skill prompt. The fourth is the generate panel, which reads
 * none of this itself -- it reads the projection over the wire. So the last
 * case holds what the projection ships, and what the panel does with it is
 * held by `video-source-places.test.ts` and `audio-source-places.test.ts` in
 * web, on entries of that shape.
 */

import { describe, it, expect, afterEach } from "vitest";

import {
  useFixtureCatalog,
  restoreRealCatalog,
  reviseFixtureCatalog,
} from "@domain/model-catalog/__tests__/fixture-catalog.js";

/**
 * Two video models: one serving a mode the panel offers, one serving a mode
 * nothing in this repository names.
 */
const VIDEO = [
  "models:",
  '  - name: "own-words-model"',
  '    display_name: "Own Words Model"',
  '    mode: "i2v"',
  "    takes_prompt: true",
  "    cost_per_call: 1",
  "    generation_time: 10",
  "    providers:",
  "      - name: wavespeed",
  '        model_id: "own-words"',
  "        priority: 1",
  "    params:",
  "      portrait:",
  '        fill: "canvas"',
  '        accepts: "image"',
  '        description: "the picture to move"',
  "        default: null",
  "      closing_frame:",
  '        fill: "canvas"',
  '        accepts: "image"',
  '        description: "where it ends up"',
  "        default: null",
  "      stabilise:",
  '        fill: "panel"',
  '        type: "boolean"',
  "        when: { source: portrait }",
  '        description: "hold the frame steady"',
  "        default: false",
  '  - name: "orbiting-model"',
  '    display_name: "Orbiting Model"',
  '    mode: "orbit"',
  "    takes_prompt: true",
  "    cost_per_call: 1",
  "    generation_time: 10",
  "    providers:",
  "      - name: wavespeed",
  '        model_id: "orbiting"',
  "        priority: 1",
  "    params:",
  "      subject:",
  '        fill: "canvas"',
  '        accepts: "image"',
  '        description: "what to circle"',
  "        default: null",
].join("\n");

/** Both modes, one of them unknown to every list in the code. */
const MODES = [
  "video:",
  "  modes:",
  "    i2v:",
  "      label: A Picture, Moving",
  "      description: Takes one picture and moves it.",
  "      sources: [image]",
  "      source_rule: any_of",
  "    orbit:",
  "      label: Orbit Around It",
  "      description: Circles the subject.",
  "      sources: [image]",
].join("\n");

/** The skill prompt these declarations are injected into. */
const SKILL = [
  "---",
  "name: generate_video_plan",
  "description: Plan a video generation",
  "---",
  "",
  "Pick a mode:",
  "",
  "{available_modes}",
].join("\n");

/**
 * Mount the catalog above.
 * @returns Nothing; the modules imported after it read this catalog.
 */
async function useSwappedCatalog(): Promise<void> {
  await useFixtureCatalog({
    modes: MODES,
    buckets: { video: VIDEO },
    skills: { generate_video_plan: SKILL },
  });
}

describe("a catalog that differs from this repository's", () => {
  afterEach(restoreRealCatalog);

  it("moves the pre-enqueue gate to the params these models declare", async () => {
    await useSwappedCatalog();
    const { violatesSourceRequirementForModel } = await import("../model-catalog.js");

    // `portrait` is a name no code in this repository has ever held a list of.
    expect(
      violatesSourceRequirementForModel("own-words-model", {
        portrait: "https://example.invalid/a.png",
      }),
    ).toBe(false);
    expect(violatesSourceRequirementForModel("own-words-model", {})).toBe(true);
    // A mode declared here and nowhere else is guarded like any other.
    expect(violatesSourceRequirementForModel("orbiting-model", {})).toBe(true);
    expect(
      violatesSourceRequirementForModel("orbiting-model", {
        subject: "https://example.invalid/a.png",
      }),
    ).toBe(false);
  });

  it("asks the proposal tool for one piece where the mode takes any one slot", async () => {
    await useSwappedCatalog();
    const { checkProposal } = await import("@domain/agent/tools/propose-canvas-action.js");

    // Two slots, and the mode says either will do -- so a group carrying one
    // empty node is right, and the tool wanted two before the rule was read.
    expect(
      checkProposal({
        nodes: [
          { role: "source", type: "image", name: "Your picture" },
          {
            role: "generate",
            type: "video",
            name: "Result",
            mode: "i2v",
            model: "own-words-model",
            params: {},
            prompt: [
              { text: "a slow pan" },
              { slot: { kind: "asset", label: "your picture", note: "Put it in the empty node" } },
            ],
          },
        ],
        edges: [],
        modelNote: "",
        rationale: "",
      }),
    ).toEqual({ ok: true });
  });

  it("writes these labels into the skill prompt", async () => {
    await useSwappedCatalog();
    const { SkillRegistry } = await import("@domain/agent/skills-loader.js");

    const body = new SkillRegistry().loadSkillContent("generate_video_plan");

    expect(body).toContain("**i2v** (A Picture, Moving): Takes one picture and moves it.");
    // The panel offers six video modes and this one is not among them, so the
    // prompt leaves it out -- which list a node opens is a product decision,
    // and it is the one thing here the catalog does not move.
    expect(body).not.toContain("orbit");
  });

  it("hands back the mode layer too when the catalog is reset", async () => {
    // The answer a model carries is built from both layers, so a reset that
    // clears only the model layer serves the new models under the old modes --
    // and the caller has no second reset to reach for.
    await useSwappedCatalog();
    const { getModelCatalog, resetModelCatalog } = await import("../model-catalog.js");
    expect(getModelCatalog().video[0]?.sourceRuleByMode.i2v).toBe("any_of");

    reviseFixtureCatalog({ modes: MODES.replace("source_rule: any_of", "source_rule: all_of") });
    resetModelCatalog();

    expect(getModelCatalog().video[0]?.sourceRuleByMode.i2v).toBe("all_of");
  });

  it("ships the panel a projection of these declarations", async () => {
    await useSwappedCatalog();
    const { getModelCatalog } = await import("../model-catalog.js");

    const entry = getModelCatalog().video.find((m) => m.name === "own-words-model");

    expect(entry?.params.portrait?.fill).toBe("canvas");
    expect(entry?.params.portrait?.accepts).toBe("image");
    expect(entry?.sourcesByMode.i2v).toEqual(["image"]);
    expect(entry?.sourceRuleByMode.i2v).toBe("any_of");
    expect(entry?.params.stabilise?.when).toEqual({ source: "portrait" });
  });
});
