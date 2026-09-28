// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a run takes its material is the model's to declare (#269).
 *
 * The two places differ in what a proposal has to draw: the reference pool is
 * fed by an edge, and a slot on the toolbar has none -- the canvas has no
 * legal wiring into it at all. So the tool refuses a wired group for a mode
 * filled by slots, and refuses an unwired one for a mode filled by the pool,
 * and which of the two it is decides whether a proposal is accepted.
 *
 * The model below serves image-to-video off the reference pool, which no model
 * in the live catalog does -- so a catalog of this file's own is what lets the
 * question be asked at all.
 */

import { type CanvasProposal } from "@breatic/shared";
import { describe, it, expect, afterEach } from "vitest";

import {
  useFixtureCatalog,
  restoreRealCatalog,
} from "@domain/model-catalog/__tests__/fixture-catalog.js";

/** A video model serving `i2v` out of the reference pool. */
const VIDEO = [
  "models:",
  '  - name: "pool-fed-model"',
  '    display_name: "Pool Fed Model"',
  '    mode: "i2v"',
  "    takes_prompt: true",
  "    cost_per_call: 1",
  "    generation_time: 10",
  "    providers:",
  "      - name: wavespeed",
  '        model_id: "pool-fed"',
  "        priority: 1",
  "    params:",
  "      images:",
  '        fill: "pool"',
  '        accepts: "image"',
  '        type: "list"',
  '        description: "the pictures to move"',
  "        default: null",
].join("\n");

/** What that mode declares. */
const MODES = [
  "video:",
  "  modes:",
  "    i2v:",
  "      label: Image to Video",
  "      sources: [image]",
].join("\n");

/**
 * A group whose one empty node is wired into the generation.
 * @returns The proposal.
 */
function wiredGroup(): CanvasProposal {
  return {
    nodes: [
      { role: "source", type: "image", name: "Your picture" },
      {
        role: "generate",
        type: "video",
        name: "Result",
        mode: "i2v",
        model: "pool-fed-model",
        params: {},
        prompt: [
          { text: "a slow pan" },
          { slot: { kind: "asset", label: "your picture", note: "Put it in the empty node" } },
        ],
      },
    ],
    edges: [{ fromIndex: 0, toIndex: 1 }],
    modelNote: "",
    rationale: "",
    groupName: "Your group",
  };
}

describe("where the tool thinks a run takes its material", () => {
  afterEach(restoreRealCatalog);

  it("comes from the model's own declaration", async () => {
    await useFixtureCatalog({ modes: MODES, buckets: { video: VIDEO } });
    const { checkProposal } = await import("../propose-canvas-action.js");

    expect(checkProposal(wiredGroup())).toEqual({ ok: true });
  });
});
