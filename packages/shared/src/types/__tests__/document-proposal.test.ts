// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A document proposal is read by the card, the landing and the check that it
 * already landed (inner#1509); each kind carries only the fields it lands with.
 */

import { describe, expect, it } from "vitest";

import { documentProposalSchema, hasWords, occurrences } from "@shared/types/document-proposal.js";

const COMMENT = {
  proposalId: "33333333-3333-4333-8333-333333333333",
  spaceId: "44444444-4444-4444-8444-444444444444",
  spaceName: "Storyboard",
  kind: "comment",
  blockId: "b-2",
  quote: "She turns",
  body: "Say why she turns.",
  title: "Motive for the turn",
  heading: "Scene 2",
  original: "She turns.",
  blockType: "paragraph",
  lossy: false,
};

describe("documentProposalSchema", () => {
  it("takes a comment, a rewrite and an insert at the end", () => {
    const { quote: _quote, ...rewrite } = { ...COMMENT, kind: "rewrite", body: "She turns slowly." };
    const insert = { ...rewrite, kind: "insert", blockId: null, original: "", body: "| a | b |\n|---|---|\n| 1 | 2 |" };
    for (const proposal of [COMMENT, rewrite, insert]) {
      expect(documentProposalSchema.safeParse(proposal).success).toBe(true);
    }
  });

  it("refuses a comment without the words it hangs on or the block it is in", () => {
    const { quote: _quote, ...noQuote } = COMMENT;
    expect(documentProposalSchema.safeParse(noQuote).success).toBe(false);
    expect(documentProposalSchema.safeParse({ ...COMMENT, blockId: null }).success).toBe(false);
  });

  it("refuses a rewrite or an insert that carries a quote", () => {
    expect(documentProposalSchema.safeParse({ ...COMMENT, kind: "rewrite" }).success).toBe(false);
    expect(documentProposalSchema.safeParse({ ...COMMENT, kind: "insert" }).success).toBe(false);
  });

  it("refuses a rewrite without the block it replaces", () => {
    const { quote: _quote, ...rewrite } = { ...COMMENT, kind: "rewrite", blockId: null };
    expect(documentProposalSchema.safeParse(rewrite).success).toBe(false);
  });

  it("refuses an empty body and an id that is not a uuid", () => {
    expect(documentProposalSchema.safeParse({ ...COMMENT, body: "" }).success).toBe(false);
    expect(documentProposalSchema.safeParse({ ...COMMENT, proposalId: "p1" }).success).toBe(false);
  });
});

describe("occurrences", () => {
  it("counts every place a quote appears, overlapping ones included", () => {
    expect(occurrences("She turns, and turns again.", "turns")).toBe(2);
    expect(occurrences("aaa", "aa")).toBe(2);
    expect(occurrences("She turns.", "leaves")).toBe(0);
  });

  it("finds nothing for an empty quote", () => {
    expect(occurrences("abc", "")).toBe(0);
    expect(occurrences("", "")).toBe(0);
  });
});

describe("hasWords (inner#1509 review round 3)", () => {
  it("is false for text that is empty or only line breaks, and true once anything else is there", () => {
    expect([hasWords(""), hasWords("\n"), hasWords("\n\n\n")]).toEqual([false, false, false]);
    expect([hasWords("a"), hasWords(" "), hasWords("\nb\n")]).toEqual([true, true, true]);
  });
});
