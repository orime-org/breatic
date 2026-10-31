// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A proposal read back from storage is checked against the shape this build
 * places (inner#1499): one stored before a format change is told apart from
 * one the canvas can still place.
 */

import { describe, expect, expectTypeOf, it } from "vitest";

import type { NodeMediaFields } from "@shared/canvas/node-media.js";
import { canvasProposalSchema, type ProposalNode } from "@shared/types/canvas-proposal.js";

/** A proposal as the tool answers with it today. */
const CURRENT = {
  nodes: [
    { role: "source", type: "image", name: "Your photo" },
    {
      role: "generate",
      type: "image",
      name: "On white",
      mode: "i2i",
      model: "some-model",
      params: { ratio: "1:1" },
      takesPrompt: true,
      fills: { images: [0] },
      prompt: [
        { text: "repaint " },
        { ref: 0 },
        { slot: { kind: "tweak", label: "the mood", note: "say how it should feel" } },
        { slot: { kind: "note", label: "Pick it in the panel" } },
      ],
    },
    {
      role: "generate",
      type: "video",
      name: "Shots",
      mode: "multi_shot",
      model: "some-video-model",
      shots: [{ prompt: [{ text: "a wide shot" }], duration: 5 }],
    },
    { role: "written", type: "text", name: "Notes", prompt: [{ text: "hello" }] },
  ],
  edges: [{ fromIndex: 0, toIndex: 1, into: "pool" }],
  modelNote: "",
  rationale: "Why",
  groupName: "On white",
};

describe("canvasProposalSchema", () => {
  it("accepts a proposal in the shape this build places", () => {
    expect(canvasProposalSchema.safeParse(CURRENT).success).toBe(true);
  });

  it("refuses a prompt mark of a kind this build no longer has", () => {
    // Stored on 2026-10-07, before the `ref` kind was taken out.
    const stale = {
      ...CURRENT,
      nodes: [
        {
          role: "generate",
          type: "image",
          name: "Turnaround",
          prompt: [{ slot: { kind: "ref", label: "Reference", note: "step one" } }],
        },
      ],
    };
    expect(canvasProposalSchema.safeParse(stale).success).toBe(false);
  });

  it("refuses a node of a type no proposal places", () => {
    const stale = { ...CURRENT, nodes: [{ role: "source", type: "web", name: "Page" }] };
    expect(canvasProposalSchema.safeParse(stale).success).toBe(false);
  });

  it("refuses an answer that is not a proposal", () => {
    expect(canvasProposalSchema.safeParse({ placed: false, reason: "no" }).success).toBe(false);
  });

  it("keeps a template node's resource and templateNode through parse (inner#1345)", () => {
    const templated = {
      ...CURRENT,
      nodes: [
        ...CURRENT.nodes,
        {
          role: "source",
          type: "image",
          name: "house style",
          resource: "templates/fixture-flow/style.png",
          templateNode: { template: "fixture-flow", key: "style" },
        },
        {
          role: "written",
          type: "text",
          name: "Fixture flow",
          prompt: [{ text: "Fixture flow\n1. Split the grid" }],
          templateNode: { template: "fixture-flow", key: "guide", anchor: 1 },
        },
      ],
    };
    const parsed = canvasProposalSchema.parse(templated);
    expect(parsed.nodes[4]).toEqual(templated.nodes[4]);
    expect(parsed.nodes[5]).toEqual(templated.nodes[5]);
  });

  it("describes a material's media fields exactly as a node's media fields", () => {
    expectTypeOf<NonNullable<ProposalNode["materialMedia"]>>().toEqualTypeOf<NodeMediaFields>();
  });
});
