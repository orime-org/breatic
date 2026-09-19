// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a mode is called is declared once, and it is the picker's word (#269).
 *
 * The mode code is nowhere in the panel: the selector renders the label and
 * nothing else, so it is the only thing a reader can match an answer against.
 * Declared a second time in the catalog it came out as `audio-to-music` and
 * `digital human`, two names no selector shows -- which is what the first case
 * below now holds the yaml to.
 *
 * Held on a catalog where a label and any table someone might write from it
 * deliberately disagree, which is the only place the question can be asked:
 * the live catalog's labels were written from the panel's own, so the two
 * agree there whichever one is read.
 */

import { describe, it, expect, afterEach } from "vitest";

import { useFixtureCatalog, restoreRealCatalog } from "./fixture-catalog.js";

/** One video model, so the mode below has something behind it. */
const VIDEO = [
  "models:",
  '  - name: "a-model"',
  '    display_name: "A Model"',
  '    mode: "t2v"',
  "    takes_prompt: true",
  "    providers:",
  "      - name: wavespeed",
  '        model_id: "a"',
  "        priority: 1",
].join("\n");

/** That mode, called something no table anywhere would guess. */
const MODES = ["video:", "  modes:", "    t2v:", "      label: Words Into Moving Pictures"].join(
  "\n",
);

describe("what the agent is told a mode is called", () => {
  afterEach(restoreRealCatalog);

  it("is the declared label, not a second table's", async () => {
    await useFixtureCatalog({ modes: MODES, buckets: { video: VIDEO } });
    const { getCanvasCapabilities } = await import("../mode-catalog.js");

    const video = getCanvasCapabilities().find((node) => node.nodeType === "video");

    expect(video?.modes).toEqual([
      { mode: "t2v", label: "Words Into Moving Pictures", what: "" },
    ]);
  });
});
