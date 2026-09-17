// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The tool counts material off the catalog, not off a table beside it (#269).
 *
 * `proposal-holds-together.test.ts` runs on the live catalog, where the
 * declarations and the table agree by construction -- the migration wrote one
 * from the other. So nothing there can tell which of the two the tool read.
 * A catalog of its own can, and it takes both layers to answer: the model
 * declares which of its parameters are slots, and the mode declares whether
 * every slot has to hold something or any one of them is enough. Below, one
 * model declares two slots where the table scores one piece, and another
 * declares three slots for a mode that takes any one of them.
 */

import { MODE_MATERIAL_COUNT, type CanvasProposal } from "@breatic/shared";
import { describe, it, expect, afterEach } from "vitest";

import {
  useFixtureCatalog,
  restoreRealCatalog,
} from "@domain/model-catalog/__tests__/fixture-catalog.js";

/** A video model serving `i2v` off two image slots, which the table scores at one. */
const VIDEO = [
  "models:",
  '  - name: "two-slot-model"',
  '    display_name: "Two Slot Model"',
  '    mode: "i2v"',
  "    takes_prompt: true",
  "    cost_per_call: 1",
  "    generation_time: 10",
  "    providers:",
  "      - name: wavespeed",
  '        model_id: "two-slot"',
  "        priority: 1",
  "    params:",
  "      image:",
  '        fill: "canvas"',
  '        accepts: "image"',
  '        description: "the first frame"',
  "        default: null",
  "      end_image:",
  '        fill: "canvas"',
  '        accepts: "image"',
  '        description: "the last frame"',
  "        default: null",
].join("\n");

/** An audio model offering `a2m` three slots, of which the mode takes any one. */
const AUDIO = [
  "models:",
  '  - name: "three-slot-model"',
  '    display_name: "Three Slot Model"',
  '    mode: "a2m"',
  "    takes_prompt: true",
  "    cost_per_call: 1",
  "    generation_time: 10",
  "    providers:",
  "      - name: wavespeed",
  '        model_id: "three-slot"',
  "        priority: 1",
  "    params:",
  "      song:",
  '        fill: "canvas"',
  '        accepts: "audio"',
  '        description: "a whole song"',
  "        default: null",
  "      voice:",
  '        fill: "canvas"',
  '        accepts: "audio"',
  '        description: "a voice alone"',
  "        default: null",
  "      instrumental:",
  '        fill: "canvas"',
  '        accepts: "audio"',
  '        description: "a backing track"',
  "        default: null",
].join("\n");

/** What those two modes declare, including the rule that makes a2m take one. */
const MODES = [
  "video:",
  "  modes:",
  "    i2v:",
  "      label: Image to Video",
  "      sources: [image]",
  "audio:",
  "  modes:",
  "    a2m:",
  "      label: Reference to Music",
  "      sources: [audio]",
  "      source_rule: any_of",
].join("\n");

/**
 * A group of one empty node feeding one generation, marked once in the prompt.
 * @param type - The node the generation is on.
 * @param mode - The mode it is set to.
 * @param model - The model it names.
 * @param source - The kind of empty node the reader is asked for.
 * @returns The proposal.
 */
function onePiece(
  type: "video" | "audio",
  mode: string,
  model: string,
  source: "image" | "audio",
): CanvasProposal {
  return {
    nodes: [
      { role: "source", type: source, name: "Your material" },
      {
        role: "generate",
        type,
        name: "Result",
        mode,
        model,
        params: {},
        prompt: [
          { text: "warm and unhurried" },
          {
            slot: { kind: "asset", label: "your material", note: "Put it in the empty node" },
          },
        ],
      },
    ],
    edges: [],
    modelNote: "",
    rationale: "",
  };
}

/**
 * The tool, reading a catalog of this file's own.
 * @returns Its proposal check, bound to that catalog.
 */
async function toolOnFixture(): Promise<(p: CanvasProposal) => unknown> {
  await useFixtureCatalog({ modes: MODES, buckets: { video: VIDEO, audio: AUDIO } });
  const { checkProposal } = await import("../propose-canvas-action.js");
  return checkProposal;
}

describe("how many pieces of material the tool asks for", () => {
  afterEach(restoreRealCatalog);

  it("comes from the model's own slots, not from the per-mode table", async () => {
    // The premise: the table and these declarations disagree, so the verdict
    // says which one was read.
    expect(MODE_MATERIAL_COUNT.video.i2v).toBe(1);
    const checkProposal = await toolOnFixture();

    expect(checkProposal(onePiece("video", "i2v", "two-slot-model", "image"))).toEqual({
      ok: false,
      reason:
        '"i2v" takes 2 piece(s) of material from the reader, and the group carries 1 empty node(s).',
    });
  });

  it("is one where the mode declares it takes any one of its slots", async () => {
    const checkProposal = await toolOnFixture();

    expect(checkProposal(onePiece("audio", "a2m", "three-slot-model", "audio"))).toEqual({
      ok: true,
    });
  });
});
