// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The tool counts material off the model's declarations (#269).
 *
 * The model declares which of its parameters are slots and, in
 * `source_groups`, when any one of several is enough (#2156). Below, one model
 * declares three optional slots of which reference-to-music takes any one.
 */

import { type CanvasProposal } from "@breatic/shared";
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

/** An audio model offering `a2m` three slots, of which it takes any one. */
const AUDIO = [
  "models:",
  '  - name: "three-slot-model"',
  '    display_name: "Three Slot Model"',
  '    mode: "a2m"',
  "    takes_prompt: true",
  "    generation_time: 10",
  "    providers:",
  "      - name: wavespeed",
  '        model_id: "three-slot"',
  "        priority: 1",
  "    params:",
  "      song:",
  '        fill: "canvas"',
  '        accepts: "audio"',
  "        optional: true",
  '        description: "a whole song"',
  "        default: null",
  "      voice:",
  '        fill: "canvas"',
  '        accepts: "audio"',
  "        optional: true",
  '        description: "a voice alone"',
  "        default: null",
  "      instrumental:",
  '        fill: "canvas"',
  '        accepts: "audio"',
  "        optional: true",
  '        description: "a backing track"',
  "        default: null",
  "    source_groups:",
  '      - mode: "a2m"',
  '        any_of: ["song", "voice", "instrumental"]',
].join("\n");

/** The two modes those models serve. */
const MODES = [
  "video:",
  "  modes:",
  "    i2v:",
  "      label: Image to Video",
  "audio:",
  "  modes:",
  "    a2m:",
  "      label: Reference to Music",
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
    groupName: "Your group",
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

  it("is one where the model takes any one of its slots", async () => {
    const checkProposal = await toolOnFixture();

    expect(checkProposal(onePiece("audio", "a2m", "three-slot-model", "audio"))).toEqual({
      ok: true,
    });
  });

});
