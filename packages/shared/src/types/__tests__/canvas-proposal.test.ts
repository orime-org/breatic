// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which feeders a proposed generation's marks may mention (#2156). A model can
 * take the same kind of material two ways -- a required slot the reader
 * clicks a node into, and a pool the prompt picks from -- and the empty node
 * the reader fills belongs in the slot first: a run without it cannot go.
 */
import { describe, expect, it } from "vitest";
import { markTargets, nameableFeeders, type CanvasProposal, type ProposalNode } from "@shared/types/canvas-proposal";

const photo = (name: string): ProposalNode => ({ role: "source", type: "image", name });

/** Kling O3 image-to-video: a required first frame and an optional pool of elements. */
const mixedRun: ProposalNode = {
  role: "generate",
  type: "video",
  name: "The clip",
  mode: "i2v",
  model: "kling-video-o3-4k-image-to-video",
  poolKinds: ["image"],
  slotKinds: ["image"],
  takesPrompt: true,
  prompt: [{ text: "walk forward" }],
};

/**
 * A proposal of these nodes, every other node wired into the last.
 * @param nodes - The nodes, the generation last.
 * @returns The proposal.
 */
function into(nodes: ProposalNode[]): CanvasProposal {
  const last = nodes.length - 1;
  return {
    nodes,
    edges: nodes.slice(0, last).map((_, fromIndex) => ({ fromIndex, toIndex: last })),
    rationale: "",
  };
}

describe("nameableFeeders", () => {
  it("sends the reader's picture to the required slot before the pool", () => {
    const proposal = into([photo("First frame"), mixedRun]);

    expect(nameableFeeders(proposal, 1).sources).toEqual([null]);
  });

  it("sends a picture past the required slots to the pool", () => {
    const proposal = into([photo("First frame"), photo("Hero"), mixedRun]);

    expect(nameableFeeders(proposal, 2).sources).toEqual([null, 1]);
  });

  it("mentions every picture where the model takes them only by the pool", () => {
    const proposal = into([photo("A"), photo("B"), { ...mixedRun, slotKinds: [] }]);

    expect(nameableFeeders(proposal, 2).sources).toEqual([0, 1]);
  });

  it("sends generated work to the required slot before the pool too", () => {
    const work: ProposalNode = { role: "generate", type: "image", name: "Knight", mode: "t2i", model: "m", poolKinds: [], takesPrompt: true };
    const proposal = into([work, mixedRun]);

    expect(nameableFeeders(proposal, 1)).toEqual({ sources: [], upstream: [null], slotted: [0] });
  });

  it("gives the slot to whichever node of that kind is listed first", () => {
    const work: ProposalNode = { role: "generate", type: "image", name: "Knight", mode: "t2i", model: "m", poolKinds: [], takesPrompt: true };
    const proposal = into([work, photo("Hero"), mixedRun]);

    expect(nameableFeeders(proposal, 2)).toEqual({ sources: [1], upstream: [null], slotted: [0] });
  });
});

describe("markTargets", () => {
  const pooled = { ...mixedRun, slotKinds: [] };

  it("sends the node each mark names and leaves an unmarked one out", () => {
    const marked = {
      ...pooled,
      prompt: [
        { text: "walk with " },
        { slot: { kind: "asset" as const, label: "hero", note: "Drop the hero in" } },
      ],
    };
    const proposal = into([photo("Hero"), photo("Extra"), marked]);

    expect(markTargets(proposal, 2)).toEqual([0]);
  });

  it("sends the upstream node a ref mark names", () => {
    const work: ProposalNode = { role: "generate", type: "image", name: "Knight", mode: "t2i", model: "m", poolKinds: [], takesPrompt: true };
    const marked = { ...pooled, prompt: [{ slot: { kind: "ref" as const, label: "knight", note: "" } }, { text: " walks" }] };

    expect(markTargets(into([work, marked]), 1)).toEqual([0]);
  });
});
