// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 A15: the shared vocabulary carries the two formula nodes, so a
 * client built before them is told to refresh instead of meeting them.
 *
 * `mathBlock` is a block whose content is plain source text, with the one
 * prop every block carries (`quoted`); `math` is inline content holding plain
 * source text and no props. BlockNote turns `content: "plain"` into the
 * ProseMirror rule `text*` for both.
 */

import { describe, it, expect } from "vitest";

import { DOCUMENT_SCHEMA } from "@shared/document-schema.js";

describe("the formula nodes in the shared vocabulary", () => {
  it("lists mathBlock with the quoted attribute and plain text content", () => {
    expect(DOCUMENT_SCHEMA.nodes.mathBlock).toEqual(["quoted"]);
    expect(DOCUMENT_SCHEMA.content.mathBlock).toBe("text*");
  });

  it("lists math with no attributes and plain text content", () => {
    expect(DOCUMENT_SCHEMA.nodes.math).toEqual([]);
    expect(DOCUMENT_SCHEMA.content.math).toBe("text*");
  });

  it("moves publishedAt past the release before formulas", () => {
    expect(Date.parse(DOCUMENT_SCHEMA.publishedAt)).toBeGreaterThan(Date.parse("2026-10-31T04:33:58Z"));
  });
});
