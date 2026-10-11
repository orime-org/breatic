// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a ref adds to a prompt's length is what the panel sends in its place
 * (inner#1315): a picture's ref is the mention of the pool its mode reads,
 * numbered within its kind. The model below caps its prompt and serves two
 * modes, each reading pictures from a pool of its own named differently, which
 * no model in the live catalog does, so a catalog of this file's own is what
 * lets the question be asked.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { CanvasProposal } from "@breatic/shared";

import { restoreRealCatalog, useFixtureCatalog } from "@domain/model-catalog/__tests__/fixture-catalog.js";

const CAP = 40;

/** An image model capping its prompt, with a pool per mode, the other mode's listed first. */
const IMAGE = [
  "models:",
  '  - name: "capped-edit"',
  '    display_name: "Capped Edit"',
  '    mode: ["t2i", "i2i"]',
  "    takes_prompt: true",
  `    max_input_chars: ${String(CAP)}`,
  "    cost_per_call: 1",
  "    generation_time: 10",
  "    providers:",
  "      - name: wavespeed",
  '        model_id: "capped"',
  "        priority: 1",
  "    params:",
  "      references:",
  '        fill: "pool"',
  '        accepts: "image"',
  '        type: "list"',
  '        mention: "THE REFERENCE PICTURE NUMBER {n}"',
  '        modes: ["t2i"]',
  '        description: "pictures to draw from"',
  "        default: null",
  "      images:",
  '        fill: "pool"',
  '        modes: ["i2i"]',
  '        accepts: "image"',
  '        type: "list"',
  '        mention: "image {n}"',
  '        description: "the pictures to edit"',
  "        default: null",
].join("\n");

const MODES = ["image:", "  modes:", "    i2i:", "      label: Image to Image", "    t2i:", "      label: Text to Image"].join("\n");

/**
 * A picture wired into the pool and @'d after the given words.
 * @param words - What the prompt says before the ref.
 * @returns The proposal.
 */
function edit(words: string): CanvasProposal {
  return {
    nodes: [
      { role: "source", type: "image", name: "Photo" },
      {
        role: "generate",
        type: "image",
        name: "Edit",
        mode: "i2i",
        model: "capped-edit",
        prompt: [{ slot: { kind: "note", label: "Put your photo in Photo first" } }, { text: words }, { ref: 0 }],
      },
    ],
    edges: [{ fromIndex: 0, toIndex: 1, into: "pool" }],
    rationale: "r",
    groupName: "g",
  };
}

describe("a picture's ref in a capped prompt", () => {
  afterEach(restoreRealCatalog);

  it("counts as its pool's mention, so the prompt fits at exactly the cap", async () => {
    await useFixtureCatalog({ modes: MODES, buckets: { image: IMAGE } });
    const { checkProposal } = await import("../propose-canvas-action.js");

    expect(checkProposal(edit("a".repeat(CAP - "image 1".length)))).toEqual({ ok: true });
  });

  it("is refused one character past the cap", async () => {
    await useFixtureCatalog({ modes: MODES, buckets: { image: IMAGE } });
    const { checkProposal } = await import("../propose-canvas-action.js");

    expect(checkProposal(edit("a".repeat(CAP - "image 1".length + 1)))).toMatchObject({ ok: false });
  });
});
