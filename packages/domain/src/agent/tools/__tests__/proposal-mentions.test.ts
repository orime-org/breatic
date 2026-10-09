// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The agent @s the nodes it wires in, for the reader (inner#1315, user
 * 2026-10-09): a `ref` segment in a prompt is an @ of another proposed node,
 * every node going into the pool is @'d, an @ of a node that lands empty
 * comes with a note saying what to do first, and the lyrics box is @'d at
 * landing with no note asked for.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadLocales } from "@breatic/core";
import type { CanvasProposal, ProposalNode } from "@breatic/shared";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

const { checkProposal, inputSchema } = await import("../propose-canvas-action.js");
const { renderGenerationModelsForModel } = await import("../generation-models.js");
const { modelsForMode } = await import("@domain/model-catalog/mode-catalog.js");

beforeEach(() => {
  loadLocales();
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

const EDIT = "nano-banana-pro-edit-ultra";
const DRAW = "nano-banana-2";

/**
 * An empty source node for the reader's picture.
 * @param name - What the reader sees.
 * @returns The node.
 */
function emptyPicture(name: string): ProposalNode {
  return { role: "source", type: "image", name };
}

/**
 * An image edit with its own prompt.
 * @param prompt - The prompt segments.
 * @returns The node.
 */
function edit(prompt: ProposalNode["prompt"]): ProposalNode {
  return { role: "generate", type: "image", name: "Watercolour", mode: "i2i", model: EDIT, prompt };
}

/**
 * A group with a name around some nodes.
 * @param nodes - The nodes.
 * @param edges - The wiring.
 * @returns The proposal.
 */
function group(nodes: ProposalNode[], edges: CanvasProposal["edges"]): CanvasProposal {
  return { nodes, edges, rationale: "r", groupName: "Group" };
}

/**
 * The reason a proposal is refused.
 * @param proposal - The proposal.
 * @returns The reason.
 * @throws {Error} When it is not refused.
 */
function refusal(proposal: CanvasProposal): string {
  const verdict = checkProposal(proposal);
  if (verdict.ok) throw new Error("expected a refusal");
  return verdict.reason;
}

const NOTE = { slot: { kind: "note" as const, label: "Put your photo in Photo first" } };

describe("a node in the pool is @'d by a ref", () => {
  it("stands with the ref and the note an empty node needs", () => {
    const proposal = group(
      [emptyPicture("Photo"), edit([NOTE, { text: "Repaint " }, { ref: 0 }, { text: " as a watercolour." }])],
      [{ fromIndex: 0, toIndex: 1, into: "pool" }],
    );

    expect(checkProposal(proposal)).toEqual({ ok: true });
  });

  it("refuses a pool node nothing @s", () => {
    const proposal = group(
      [emptyPicture("Photo"), edit([NOTE, { text: "Repaint it as a watercolour." }])],
      [{ fromIndex: 0, toIndex: 1, into: "pool" }],
    );

    expect(refusal(proposal)).toMatch(/"Photo".*ref/);
  });

  it("refuses a ref to a node not wired into this pool", () => {
    const proposal = group(
      [emptyPicture("Photo"), edit([{ text: "Repaint " }, { ref: 0 }])],
      [],
    );

    expect(refusal(proposal)).toMatch(/"Photo".*pool/);
  });

  it("asks for a note when the @'d node lands empty", () => {
    const proposal = group(
      [emptyPicture("Photo"), edit([{ text: "Repaint " }, { ref: 0 }])],
      [{ fromIndex: 0, toIndex: 1, into: "pool" }],
    );

    expect(refusal(proposal)).toMatch(/"Photo".*empty.*note/);
  });

  it("asks for a note when the @'d node is a generation still to run", () => {
    const upstream: ProposalNode = {
      role: "generate",
      type: "image",
      name: "Character",
      mode: "t2i",
      model: DRAW,
      prompt: [{ text: "A girl in a red coat." }],
    };
    const proposal = group(
      [upstream, edit([{ text: "Repaint " }, { ref: 0 }])],
      [{ fromIndex: 0, toIndex: 1, into: "pool" }],
    );

    expect(refusal(proposal)).toMatch(/"Character".*empty.*note/);
  });

  it("does not let an asset mark through any more", () => {
    const sent = {
      nodes: [emptyPicture("Photo"), edit([{ slot: { kind: "asset", label: "the photo", note: "@ the photo" } }])],
      edges: [{ fromIndex: 0, toIndex: 1, into: "pool" }],
      rationale: "r",
      groupName: "g",
    };

    expect(inputSchema.safeParse(sent).success).toBe(false);
  });

  it("points a typed reference mark at ref", () => {
    const proposal = group(
      [emptyPicture("Photo"), edit([NOTE, { text: "Repaint [📎 the photo] as a watercolour." }])],
      [{ fromIndex: 0, toIndex: 1, into: "pool" }],
    );

    expect(refusal(proposal)).toContain('{"ref"');
  });
});

describe("a template-started node", () => {
  it("refuses a node naming a template without its own prompt, giving the template's words with refs", () => {
    const node: ProposalNode = { role: "generate", type: "image", name: "Board", template: "storyboard-grid-25" };
    const proposal = group([emptyPicture("Reference"), node], [{ fromIndex: 0, toIndex: 1, into: "pool" }]);

    const reason = refusal(proposal);

    expect(reason).toContain("prompt");
    expect(reason).toContain('{"ref"');
    expect(reason).not.toContain("📎");
  });
});

describe("the lyrics box", () => {
  it("takes a written text node with no note", () => {
    const lyrics: ProposalNode = { role: "written", type: "text", name: "Lyrics", prompt: [{ text: "La la la" }] };
    const song: ProposalNode = {
      role: "generate",
      type: "audio",
      name: "Song",
      mode: "t2m",
      model: "mureka-v9.5-generate-song",
      prompt: [{ text: "A gentle pop song." }],
    };
    const proposal = group([lyrics, song], [{ fromIndex: 0, toIndex: 1, into: "lyrics" }]);

    expect(checkProposal(proposal)).toEqual({ ok: true });
  });
});

describe("the length the panel sends", () => {
  it("counts a referenced text node's words once", () => {
    const words: ProposalNode = { role: "written", type: "text", name: "Script", prompt: [{ text: "x".repeat(40) }] };
    const proposal = group(
      [words, edit([{ text: "Use " }, { ref: 0 }])],
      [{ fromIndex: 0, toIndex: 1, into: "pool" }],
    );

    expect(checkProposal(proposal)).toEqual({ ok: true });
  });
});

describe("a loose empty node", () => {
  it("cannot borrow the note another node needs", () => {
    const loose = emptyPicture("Spare");
    const proposal = group(
      [emptyPicture("Photo"), loose, edit([NOTE, { text: "Repaint " }, { ref: 0 }])],
      [{ fromIndex: 0, toIndex: 2, into: "pool" }],
    );

    expect(refusal(proposal)).toContain('"Spare"');
  });
});

describe("what the model list says", () => {
  it("speaks of refs and asks no note for the lyrics box", () => {
    const text = renderGenerationModelsForModel(modelsForMode("audio", "t2m") as never);

    expect(text).not.toContain("asset mark");
    expect(text).toContain("lyrics box");
    expect(text).not.toMatch(/lyrics box[^.;]*a note/);
  });
});
