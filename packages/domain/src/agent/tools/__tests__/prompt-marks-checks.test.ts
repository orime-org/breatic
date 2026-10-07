// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the proposal check asks of the marks once the reader @s every
 * reference by hand (inner#977): no mark is paired with a node, but every
 * node they could @ has a bracket telling them to, a note is never words of a
 * written node, and the words a wired text node holds count against the cap
 * they will be @'d into.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadLocales } from "@breatic/core";
import type { CanvasProposal, ProposalNode } from "@breatic/shared";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { checkProposal, inputSchema, makeProposeCanvasAction } from "../propose-canvas-action.js";

beforeEach(() => {
  loadLocales();
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

/**
 * A reference mark, the bracket asking the reader to @ something.
 * @param label - What to @.
 * @returns The segment.
 */
function reference(label: string): { slot: { kind: "asset"; label: string; note: string } } {
  return { slot: { kind: "asset", label, note: label } };
}

/** A character generated first, the upstream work a later node draws on. */
const CHARACTER: ProposalNode = {
  role: "generate",
  type: "image",
  name: "Character",
  mode: "t2i",
  model: "nano-banana-2",
  prompt: [{ text: "A courier in a red coat." }],
};

/**
 * An image-to-image node fed by the given nodes, all listed before it.
 * @param feeders - What is wired into it.
 * @param prompt - Its prompt.
 * @returns The proposal.
 */
function edit(feeders: ProposalNode[], prompt: NonNullable<ProposalNode["prompt"]>): CanvasProposal {
  return {
    nodes: [
      ...feeders,
      { role: "generate", type: "image", name: "Night", mode: "i2i", model: "nano-banana-pro-edit-ultra", prompt },
    ],
    edges: feeders.map((_, i) => ({ fromIndex: i, toIndex: feeders.length })),
    rationale: "A night version of the character.",
    groupName: "Night",
  };
}

describe("the marks a proposal sends", () => {
  it("takes a note with a label alone, and no longer takes a ref mark", () => {
    const base = edit([CHARACTER], [reference("the generated character"), { text: " at night" }]);
    const withNote = { ...base, nodes: base.nodes.map((n, i) => (i === 1 ? { ...n, prompt: [{ slot: { kind: "note", label: "Pick it in the panel" } }, ...(n.prompt ?? [])] } : n)) };
    expect(inputSchema.safeParse(withNote).success).toBe(true);
    const withRef = { ...base, nodes: base.nodes.map((n, i) => (i === 1 ? { ...n, prompt: [{ slot: { kind: "ref", label: "x", note: "x" } }] } : n)) };
    expect(inputSchema.safeParse(withRef).success).toBe(false);
  });
});

describe("every node the reader could @ has a bracket", () => {
  it("refuses generated work wired in with no reference mark, naming it", () => {
    const answer = checkProposal(edit([CHARACTER], [{ text: "Make it night." }]));
    expect(answer).toMatchObject({ ok: false, reason: expect.stringContaining('"Character"') });
  });

  it("places it with one reference mark", () => {
    expect(checkProposal(edit([CHARACTER], [reference("the generated character"), { text: " at night" }]))).toEqual({ ok: true });
  });

  it("counts empty nodes and generated work together", () => {
    const photo: ProposalNode = { role: "source", type: "image", name: "Photo" };
    const answer = checkProposal(edit([photo, CHARACTER], [reference("the uploaded photo"), { text: " at night" }]));
    expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/"Photo".*"Character"/) });
  });

  it("does not count a node the model's slot takes, which a note describes", () => {
    const frame: ProposalNode = { role: "source", type: "image", name: "First frame" };
    const proposal: CanvasProposal = {
      nodes: [
        frame,
        {
          role: "generate",
          type: "video",
          name: "Clip",
          mode: "i2v",
          model: "kling-video-o3-4k-image-to-video",
          prompt: [{ slot: { kind: "note", label: "Pick the first frame in the panel" } }, { text: "She walks forward." }],
        },
      ],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      rationale: "",
      groupName: "Clip",
    };
    expect(checkProposal(proposal)).toEqual({ ok: true });
  });
});

describe("a written node", () => {
  it("is refused when it carries a note, which never reaches its words", () => {
    const proposal: CanvasProposal = {
      nodes: [
        { role: "written", type: "text", name: "Script", prompt: [{ slot: { kind: "note", label: "Read it aloud" } }, { text: "Hello there." }] },
        { role: "generate", type: "audio", name: "Voice", mode: "tts", model: "realtime-tts-2", prompt: [reference("the script the Agent wrote")] },
      ],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      rationale: "",
      groupName: "Voice",
    };
    expect(checkProposal(proposal)).toMatchObject({ ok: false, reason: expect.stringContaining('"Script"') });
  });
});

describe("the words a wired text node holds", () => {
  /**
   * A script of the given length read by a speech model that takes 2000 characters.
   * @param length - How many characters the script holds.
   * @returns The proposal.
   */
  function speech(length: number): CanvasProposal {
    return {
      nodes: [
        { role: "written", type: "text", name: "Script", prompt: [{ text: "a".repeat(length) }] },
        { role: "generate", type: "audio", name: "Voice", mode: "tts", model: "realtime-tts-2", prompt: [reference("the script the Agent wrote")] },
      ],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      rationale: "",
      groupName: "Voice",
    };
  }

  it("count against the cap as if the reader @s it, and the refusal names the node", () => {
    expect(checkProposal(speech(2100))).toMatchObject({ ok: false, reason: expect.stringContaining('"Script"') });
  });

  it("fit when the script is within the cap", () => {
    expect(checkProposal(speech(1000))).toEqual({ ok: true });
  });

  it("are refused against one shot's limit when the model takes shots", () => {
    const proposal: CanvasProposal = {
      nodes: [
        { role: "written", type: "text", name: "Script", prompt: [{ text: "b".repeat(600) }] },
        {
          role: "generate",
          type: "video",
          name: "Clip",
          mode: "multi_shot",
          model: "kling-v3.0-4k-text-to-video",
          params: { duration: 5 },
          shots: [
            { prompt: [reference("the script the Agent wrote")], duration: 2 },
            { prompt: [{ text: "the pond at dusk" }], duration: 3 },
          ],
        },
      ],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      rationale: "",
      groupName: "Clip",
    };
    expect(checkProposal(proposal)).toMatchObject({ ok: false, reason: expect.stringMatching(/"Script".*512/) });
  });
});

describe("what the agent is told about marks", () => {
  it("says the reader @s by hand and keeps no pairing or ref mark", () => {
    const said = JSON.stringify(inputSchema.toJSONSchema()) + (makeProposeCanvasAction().description ?? "");
    expect(said).not.toMatch(/\bref\b|k-th|pairs with/);
    expect(said).toMatch(/@/);
    expect(said).toMatch(/note/);
  });

  it("asks for the prompt in the language the reader writes in", () => {
    expect(JSON.stringify(inputSchema.toJSONSchema())).toMatch(/language the reader/);
  });
});
