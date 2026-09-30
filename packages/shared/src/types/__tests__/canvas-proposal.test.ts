// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which feeders a proposed generation's marks may mention (#2156). A model can
 * take the same kind of material two ways -- a required slot the reader
 * clicks a node into, and a pool the prompt picks from -- and the empty node
 * the reader fills belongs in the slot first: a run without it cannot go.
 */
import { describe, expect, it } from "vitest";
import { markTargets, nameableFeeders, proposalMarkSegments, type CanvasProposal, type ProposalNode } from "@shared/types/canvas-proposal";

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

    expect(nameableFeeders(proposal, 1)).toEqual({ sources: [], upstream: [], slotted: [0] });
  });

  it("gives the slot to whichever node of that kind is listed first", () => {
    const work: ProposalNode = { role: "generate", type: "image", name: "Knight", mode: "t2i", model: "m", poolKinds: [], takesPrompt: true };
    const proposal = into([work, photo("Hero"), mixedRun]);

    expect(nameableFeeders(proposal, 2)).toEqual({ sources: [1], upstream: [], slotted: [0] });
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

  // The slot's node is picked in the panel, so the first ref mark is about the
  // next node of that kind, the one headed for the pool.
  it("sends a ref mark past the generated work that fills the slot", () => {
    const work = (name: string): ProposalNode => ({ role: "generate", type: "image", name, mode: "t2i", model: "m", poolKinds: [], takesPrompt: true });
    const marked = { ...mixedRun, prompt: [{ text: "walk to " }, { slot: { kind: "ref" as const, label: "castle", note: "" } }] };
    const proposal = into([work("Knight"), work("Castle"), marked]);

    expect(nameableFeeders(proposal, 2)).toEqual({ sources: [], upstream: [1], slotted: [0] });
    expect(markTargets(proposal, 2)).toEqual([1]);
  });

  it("sends the upstream node a ref mark names", () => {
    const work: ProposalNode = { role: "generate", type: "image", name: "Knight", mode: "t2i", model: "m", poolKinds: [], takesPrompt: true };
    const marked = { ...pooled, prompt: [{ slot: { kind: "ref" as const, label: "knight", note: "" } }, { text: " walks" }] };

    expect(markTargets(into([work, marked]), 1)).toEqual([0]);
  });
});

describe("the marks of a node with shots (#2218)", () => {
  const pooled = { ...mixedRun, slotKinds: [] };
  const asset = (label: string) => ({ slot: { kind: "asset" as const, label, note: "" } });

  it("reads the main prompt first, then each shot in order", () => {
    const node: ProposalNode = {
      ...pooled,
      prompt: [{ text: "a " }, asset("a")],
      shots: [
        { prompt: [asset("b")], duration: 2 },
        { prompt: [{ text: "then " }, asset("c")], duration: 3 },
      ],
    };
    expect(proposalMarkSegments(node).filter((s) => s.slot).map((s) => s.slot?.label)).toEqual(["a", "b", "c"]);
  });

  it("sends the node each shot's mark names, counting across shots", () => {
    const node: ProposalNode = {
      ...pooled,
      prompt: undefined,
      shots: [
        { prompt: [asset("hero")], duration: 2 },
        { prompt: [asset("extra")], duration: 3 },
      ],
    };
    expect(markTargets(into([photo("Hero"), photo("Extra"), node]), 2)).toEqual([0, 1]);
  });
});
