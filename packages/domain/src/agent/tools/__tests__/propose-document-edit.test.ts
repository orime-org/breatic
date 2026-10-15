// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A proposed edit to the open document (inner#1509): checked against the
 * blocks the reader's browser sent this turn, and refused with what is wrong,
 * the rule and the facts the agent needs to put it right.
 */

import { describe, expect, it } from "vitest";
import { documentProposalSchema, type ChatDocumentBlock } from "@breatic/shared";

import {
  answerDocumentEdit,
  documentEditInputSchema,
  makeProposeDocumentEdit,
  renderDocumentProposalForModel,
  type OpenDocument,
} from "@domain/agent/tools/propose-document-edit.js";

const PROPOSAL_ID = "33333333-3333-4333-8333-333333333333";

/**
 * A block as the browser sends it.
 * @param id - Its id.
 * @param type - Its BlockNote type.
 * @param text - Its plain text.
 * @param more - Anything else it says.
 * @returns The block.
 */
function block(id: string, type: string, text: string, more: Partial<ChatDocumentBlock> = {}): ChatDocumentBlock {
  return { id, type, text, lossy: false, partial: false, ...more };
}

const DOC: OpenDocument = {
  spaceId: "44444444-4444-4444-8444-444444444444",
  spaceName: "Storyboard",
  blocks: [
    block("h1", "heading", "Scene 1"),
    block("p1", "paragraph", "The hero arrives at the gate."),
    block("h2", "heading", "Scene 2"),
    block("t1", "table", "Shot\nAction\nClose\nShe turns", { lossy: true }),
    block("p2", "paragraph", "She turns, and turns again."),
    block("p3", "paragraph", "", { partial: true }),
  ],
};

/**
 * The answer for one input.
 * @param input - What the agent sent.
 * @param open - The open document, or null.
 * @returns The answer.
 */
function answer(input: Parameters<typeof answerDocumentEdit>[0], open: OpenDocument | null = DOC): ReturnType<typeof answerDocumentEdit> {
  return answerDocumentEdit(input, open, PROPOSAL_ID);
}

/**
 * Why an answer was refused.
 * @param input - What the agent sent.
 * @param open - The open document, or null.
 * @returns The reason.
 */
function refusal(input: Parameters<typeof answerDocumentEdit>[0], open: OpenDocument | null = DOC): string {
  const got = answer(input, open);
  if (got.placed) throw new Error("expected a refusal");
  return got.reason;
}

describe("a proposal that holds together", () => {
  it("comments on words in a block, under the nearest heading above it", () => {
    const got = answer({ kind: "comment", block: 4, quote: "Close\nShe turns", body: "Why close?", title: "Shot size" });

    expect(got).toEqual({
      placed: true,
      proposalId: PROPOSAL_ID,
      spaceId: DOC.spaceId,
      spaceName: "Storyboard",
      kind: "comment",
      blockId: "t1",
      quote: "Close\nShe turns",
      body: "Why close?",
      title: "Shot size",
      heading: "Scene 2",
      original: "Shot\nAction\nClose\nShe turns",
      blockType: "table",
      lossy: false,
    });
  });

  it("rewrites a block, carrying whether a Markdown rewrite drops something", () => {
    const got = answer({ kind: "rewrite", block: 4, body: "| Shot | Action |\n|---|---|\n| Wide | She turns |", title: "Wider" });

    expect(got).toMatchObject({ placed: true, kind: "rewrite", blockId: "t1", lossy: true, original: "Shot\nAction\nClose\nShe turns" });
    expect(got).not.toHaveProperty("quote");
  });

  it("inserts after a block, or at the end when it names none", () => {
    expect(answer({ kind: "insert", block: 2, body: "A new line.", title: "Add" })).toMatchObject({
      placed: true,
      blockId: "p1",
      heading: "Scene 1",
      original: "The hero arrives at the gate.",
    });
    expect(answer({ kind: "insert", body: "## Scene 3", title: "Add" })).toMatchObject({
      placed: true,
      blockId: null,
      heading: "Scene 2",
      original: "",
      blockType: null,
    });
  });

  it("answers in the shape the card reads back", () => {
    const got = answer({ kind: "comment", block: 2, quote: "the gate", body: "Which gate?", title: "Gate" });

    expect(documentProposalSchema.safeParse(got).success).toBe(true);
  });

  it("has no heading for a block above every heading", () => {
    const open = { ...DOC, blocks: [block("p0", "paragraph", "Opening line."), ...DOC.blocks] };

    expect(answer({ kind: "rewrite", block: 1, body: "First line.", title: "Open" }, open)).toMatchObject({ heading: "" });
  });
});

describe("a refused proposal says what is wrong and the facts to fix it", () => {
  it("when the reader has no readable document open", () => {
    expect(refusal({ kind: "insert", body: "x", title: "t" }, null)).toMatch(/no document open/i);
  });

  it("when a comment or a rewrite names no block", () => {
    expect(refusal({ kind: "rewrite", body: "x", title: "t" })).toMatch(/rewrite names the block/i);
    expect(refusal({ kind: "comment", quote: "gate", body: "x", title: "t" })).toMatch(/comment names the block/i);
  });

  it("when the block is not in the document, with the range there is", () => {
    expect(refusal({ kind: "rewrite", block: 9, body: "x", title: "t" })).toMatch(/block 9\b.*1 to 6/i);
  });

  it("when the block was cut at the limit", () => {
    expect(refusal({ kind: "rewrite", block: 6, body: "x", title: "t" })).toMatch(/block 6\b.*cut/i);
  });

  it("when a comment carries no quote, or a rewrite or an insert carries one", () => {
    expect(refusal({ kind: "comment", block: 2, body: "x", title: "t" })).toMatch(/comment .*quote/i);
    expect(refusal({ kind: "rewrite", block: 2, quote: "gate", body: "x", title: "t" })).toMatch(/only a comment/i);
    expect(refusal({ kind: "insert", block: 2, quote: "gate", body: "x", title: "t" })).toMatch(/only a comment/i);
  });

  it("when the quote is not in the block, handing back the block's plain text and how it is matched", () => {
    const reason = refusal({ kind: "comment", block: 4, quote: "| Close | She turns |", body: "x", title: "t" });

    expect(reason).toContain(JSON.stringify("Shot\nAction\nClose\nShe turns"));
    expect(reason).toMatch(/without Markdown/i);
    expect(reason).toMatch(/one per line/i);
  });

  it("when the quote appears more than once, with how many times", () => {
    expect(refusal({ kind: "comment", block: 5, quote: "turns", body: "x", title: "t" })).toMatch(/2 times/);
  });

  it("when the body holds nothing", () => {
    expect(refusal({ kind: "insert", body: "  \n ", title: "t" })).toMatch(/body/i);
  });
});

describe("what the model reads back", () => {
  it("is one line, not the proposal", () => {
    expect(renderDocumentProposalForModel({ placed: false, reason: "No." })).toBe(
      "That proposal was refused, so nothing is on screen. No.",
    );
    expect(renderDocumentProposalForModel(answer({ kind: "insert", body: "x", title: "t" }))).toMatch(/card/);
  });
});

describe("the tool", () => {
  it("reads the open document from its context and gives each proposal its own id", async () => {
    const tool = makeProposeDocumentEdit();
    const run = (): Promise<unknown> =>
      Promise.resolve(
        tool.execute?.({ kind: "insert", body: "x", title: "t" }, {
          toolCallId: "c1",
          messages: [],
          context: { openDocument: DOC },
        }),
      );

    const [a, b] = (await Promise.all([run(), run()])) as Array<{ placed: boolean; proposalId: string }>;

    expect(a?.placed).toBe(true);
    expect(a?.proposalId).not.toBe(b?.proposalId);
  });
});

describe("an empty quote (inner#1509 review round 1)", () => {
  it("is refused by the input schema", () => {
    expect(documentEditInputSchema.safeParse({ kind: "comment", block: 2, quote: "", body: "x", title: "t" }).success).toBe(false);
  });

  it("is refused by the check rather than searched for", () => {
    expect(refusal({ kind: "comment", block: 2, quote: "", body: "x", title: "t" })).toMatch(/hangs on words/i);
  });
});

describe("a quote with no words (inner#1509 review round 3)", () => {
  it("is refused, saying a comment hangs on words", () => {
    expect(refusal({ kind: "comment", block: 4, quote: "\n", body: "x", title: "t" })).toMatch(/hangs on words/i);
  });
});

describe("the tool's description", () => {
  it("asks for content that follows one place to go in one insert", () => {
    expect(makeProposeDocumentEdit().description).toMatch(/one insert/i);
  });

  it("says the document has three heading levels (review round 4)", () => {
    expect(makeProposeDocumentEdit().description).toMatch(/headings? .*levels? 1 to 3|#, ## and ###/i);
  });
});
