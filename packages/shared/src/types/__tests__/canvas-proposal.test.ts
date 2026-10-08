// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which segments of a proposed node can carry a mark (#2218).
 */
import { describe, expect, it } from "vitest";
import {
  feedsOf,
  layersOf,
  proposalMarkSegments,
  type CanvasProposal,
  type ProposalNode,
} from "@shared/types/canvas-proposal";

describe("the marks of a node with shots (#2218)", () => {
  const asset = (label: string) => ({ slot: { kind: "asset" as const, label, note: "" } });

  it("reads the main prompt first, then each shot in order", () => {
    const node: ProposalNode = {
      role: "generate",
      type: "video",
      name: "The clip",
      mode: "multi_shot",
      model: "kling-v3.0-4k-text-to-video",
      takesPrompt: true,
      prompt: [{ text: "a " }, asset("a")],
      shots: [
        { prompt: [asset("b")], duration: 2 },
        { prompt: [{ text: "then " }, asset("c")], duration: 3 },
      ],
    };
    expect(proposalMarkSegments(node).filter((s) => s.slot).map((s) => s.slot?.label)).toEqual(["a", "b", "c"]);
  });
});

describe("a material node joined through fills (inner#1315)", () => {
  const portrait: ProposalNode = {
    role: "source",
    type: "image",
    name: "Portrait",
    material: "https://resource.example/image/a.png",
  };
  const talk: ProposalNode = {
    role: "generate",
    type: "video",
    name: "Talking head",
    mode: "talking_head",
    model: "omnihuman-1.5",
    fills: { image: [0] },
  };
  const proposal: CanvasProposal = { nodes: [portrait, talk], edges: [], rationale: "r" };

  it("counts a fill as a feed from the material node to the generation", () => {
    expect(feedsOf(proposal)).toEqual([{ fromIndex: 0, toIndex: 1 }]);
  });

  it("feeds the edges first, then each fill", () => {
    const wired: CanvasProposal = { ...proposal, edges: [{ fromIndex: 0, toIndex: 1, into: "pool" }] };
    expect(feedsOf(wired)).toEqual([
      { fromIndex: 0, toIndex: 1 },
      { fromIndex: 0, toIndex: 1 },
    ]);
  });

  it("places the material one layer before the generation it fills", () => {
    expect(layersOf(proposal)).toEqual([0, 1]);
  });
});
