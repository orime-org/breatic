// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Swap the catalog and every answer follows, with no code changed (#269).
 *
 * This is the whole point stated as one test. The catalog below differs from
 * the repository's in four ways a deployment could plausibly differ: a model
 * spells its picture `portrait`, it takes any one of the two slots it offers
 * rather than both, one of its controls waits on a switch of its own, and
 * there is a mode nothing in this repository has ever heard of.
 *
 * Two of the three consumers run here: the pre-enqueue gate and the proposal
 * tool. The third is the generate panel, which reads
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
  "    generation_time: 10",
  "    providers:",
  "      - name: wavespeed",
  '        model_id: "own-words"',
  "        priority: 1",
  "    params:",
  "      portrait:",
  '        fill: "canvas"',
  '        accepts: "image"',
  "        optional: true",
  '        description: "the picture to move"',
  "        default: null",
  "      closing_frame:",
  '        fill: "canvas"',
  '        accepts: "image"',
  "        optional: true",
  '        description: "where it ends up"',
  "        default: null",
  "      steady:",
  '        fill: "panel"',
  '        description: "keep the camera still"',
  "        values: [true, false]",
  "        default: false",
  "      stabilise:",
  '        fill: "panel"',
  "        when: { flag_on: steady }",
  '        description: "how hard to hold the frame"',
  "        values: [low, high]",
  "        default: low",
  "    source_groups:",
  '      - mode: "i2v"',
  '        any_of: ["portrait", "closing_frame"]',
  '  - name: "orbiting-model"',
  '    display_name: "Orbiting Model"',
  '    mode: "orbit"',
  "    takes_prompt: true",
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
  "    orbit:",
  "      label: Orbit Around It",
  "      description: Circles the subject.",
].join("\n");

/**
 * Mount the catalog above.
 * @returns Nothing; the modules imported after it read this catalog.
 */
async function useSwappedCatalog(): Promise<void> {
  await useFixtureCatalog({
    modes: MODES,
    buckets: { video: VIDEO },
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

  it("asks the proposal tool for one piece where the model takes any one slot", async () => {
    await useSwappedCatalog();
    const { checkProposal } = await import("@domain/agent/tools/propose-canvas-action.js");

    // Two slots, and the model says either will do -- so a group carrying one
    // empty node is right, and the tool wanted two before the group was read.
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
              { slot: { kind: "note", label: "Put your picture in the empty node, then pick it into the slot" } },
            ],
          },
        ],
        edges: [],
        modelNote: "",
        rationale: "",
        groupName: "A slow pan",
      }),
    ).toEqual({ ok: true });
  });

  it("hands back the mode layer too when the catalog is reset", async () => {
    // The catalog checks its models against the mode layer, so a reset that
    // clears only the model layer checks the new models against the old
    // modes -- and the caller has no second reset to reach for.
    await useSwappedCatalog();
    const { resetModelCatalog } = await import("../model-catalog.js");
    const { getModeConfig } = await import("../mode-config.js");
    expect(getModeConfig().video?.modes.i2v?.label).toBe("A Picture, Moving");

    reviseFixtureCatalog({ modes: MODES.replace("A Picture, Moving", "A Picture, Still Moving") });
    resetModelCatalog();

    expect(getModeConfig().video?.modes.i2v?.label).toBe("A Picture, Still Moving");
  });

  it("ships the panel a projection of these declarations", async () => {
    await useSwappedCatalog();
    const { getModelCatalog } = await import("../model-catalog.js");

    const entry = getModelCatalog().video.find((m) => m.name === "own-words-model");

    expect(entry?.params.portrait?.fill).toBe("canvas");
    expect(entry?.params.portrait?.accepts).toBe("image");
    expect(entry?.source_groups).toEqual([{ mode: "i2v", any_of: ["portrait", "closing_frame"] }]);
    expect(entry?.params.stabilise?.when).toEqual({ flag_on: "steady" });
  });
});
