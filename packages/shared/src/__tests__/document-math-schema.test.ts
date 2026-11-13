// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 A15: the shared vocabulary carries the two formula nodes, so a
 * client built before them is told to refresh instead of meeting them.
 *
 * Both are leaves holding their LaTeX in a `source` attribute (design 5.1):
 * `mathBlock` also carries the prop every block carries (`quoted`), and
 * `math` is inline content. A leaf has the empty content rule, as `image`.
 */

import { describe, it, expect } from "vitest";

import { DOCUMENT_SCHEMA } from "@shared/document-schema.js";

describe("the formula nodes in the shared vocabulary", () => {
  it("lists mathBlock as a leaf with the quoted and source attributes", () => {
    expect(DOCUMENT_SCHEMA.nodes.mathBlock).toEqual(["quoted", "source"]);
    expect(DOCUMENT_SCHEMA.content.mathBlock).toBe("");
  });

  it("lists math as a leaf with the source attribute", () => {
    expect(DOCUMENT_SCHEMA.nodes.math).toEqual(["source"]);
    expect(DOCUMENT_SCHEMA.content.math).toBe("");
  });

  it("moves publishedAt past the release before formulas", () => {
    expect(Date.parse(DOCUMENT_SCHEMA.publishedAt)).toBeGreaterThan(Date.parse("2026-10-31T04:33:58Z"));
  });
});
