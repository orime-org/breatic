// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A video or a picture goes into a sound generation's video or image slot
 * the way any node goes into a slot (inner#1825 design 5): the canvas lets
 * the line be drawn now, so an empty node is wired in with a note and one
 * holding material fills the slot, where before the empty one could only be
 * left unwired.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadLocales } from "@breatic/core";
import { canConnect, type ProposalNode } from "@breatic/shared";

import { modelsForMode, type ModelInfo } from "@domain/model-catalog/mode-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { checkProposal } from "../propose-canvas-action.js";
import { entriesFor } from "../proposal-routing.js";

beforeEach(() => {
  loadLocales();
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

/**
 * A sound model as the catalog serves it.
 * @param mode - Its mode.
 * @param name - Its name.
 * @returns The model.
 */
function soundModel(mode: string, name: string): ModelInfo {
  const reach = modelsForMode("audio", mode);
  const chosen = reach.available ? reach.models.find((model) => model.name === name) : undefined;
  if (chosen === undefined) throw new Error(`no audio model ${name} in ${mode}`);
  return chosen;
}

/** Each sound model with a slot for a video or a picture, and that slot. */
const SLOTS = [
  ["a2m", "sonilo-video-to-music", "video"],
  ["sfx", "hunyuan-video-foley", "video"],
  ["t2m", "lyria-3-pro-music", "image"],
] as const;

describe("a video or a picture into a sound generation's slot (inner#1825 design 5)", () => {
  it("is a line the canvas lets be drawn", () => {
    expect(canConnect("video", "audio")).toBe(true);
    expect(canConnect("image", "audio")).toBe(true);
  });

  for (const [mode, name, kind] of SLOTS) {
    it(`goes into "${kind}" of ${name} by an edge and a note when empty, through fills when holding material, never unwired`, () => {
      const chosen = soundModel(mode, name);
      const empty = entriesFor(chosen, kind, "empty");
      expect(empty.map((entry) => ({ into: entry.way.into, by: entry.by, ref: entry.ref, note: entry.note }))).toEqual([{ into: kind, by: "edge", ref: false, note: true }]);
      const held = entriesFor(chosen, kind, "material");
      expect(held.map((entry) => ({ into: entry.way.into, by: entry.by }))).toEqual([{ into: kind, by: "fills" }]);
    });
  }

  it("places an empty video wired into the music model's video slot with a note", () => {
    const nodes: ProposalNode[] = [
      { role: "source", type: "video", name: "Clip" },
      {
        role: "generate",
        type: "audio",
        name: "Score",
        mode: "a2m",
        model: "sonilo-video-to-music",
        prompt: [{ slot: { kind: "note", label: "Put the clip in Clip, then pick it into the video slot" } }, { text: "Warm strings that follow the cuts." }],
      },
    ];
    expect(checkProposal({ nodes, edges: [{ fromIndex: 0, toIndex: 1, into: "video" }], rationale: "Score the clip.", groupName: "Score" })).toEqual({ ok: true });
  });
});
