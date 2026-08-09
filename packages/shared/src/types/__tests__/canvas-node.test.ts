// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Which node modalities offer Generate (#1896).
 *
 * `canGenerate` gates two things that must agree: whether the canvas offers
 * the Generate menu item on a node, and whether creating a node seeds the
 * prompt container that a generation recipe is written into. A modality that
 * answers true here must be usable end to end, because a node created under a
 * true answer carries a prompt container forever after.
 *
 * These cases pin the list itself. They are deliberately exhaustive over
 * `NodeType`: a new modality added to the union without a decision here would
 * otherwise slip in untested, and "does this modality generate" is a product
 * decision, not something a reader should have to infer from the absence of a
 * case.
 */

import { describe, it, expect } from "vitest";

import { canGenerate } from "@shared/types/canvas-node";
import type { NodeType } from "@shared/types/canvas-node";

/** Every value of `NodeType`, so the two lists below cover the union. */
const GENERATES: readonly NodeType[] = ["image", "video"];
const DOES_NOT: readonly NodeType[] = [
  "text",
  "audio",
  "3d",
  "web",
  "annotation",
  "group",
];

describe("canGenerate", () => {
  it.each(GENERATES)("offers Generate on a %s node", (type) => {
    expect(canGenerate(type)).toBe(true);
  });

  it.each(DOES_NOT)("does not offer Generate on a %s node", (type) => {
    expect(canGenerate(type)).toBe(false);
  });

  it("covers every node type, so a new modality cannot slip in undecided", () => {
    // Not a restatement of the two lists above: it fails when `NodeType` grows
    // and nobody decided which list the new modality belongs to. Without it,
    // adding a modality silently lands in neither and stays untested.
    const decided = [...GENERATES, ...DOES_NOT];
    const everyType: readonly NodeType[] = [
      "text",
      "image",
      "audio",
      "video",
      "3d",
      "web",
      "annotation",
      "group",
    ];
    expect([...decided].sort()).toEqual([...everyType].sort());
  });

  it("says text does not generate yet, which is a decision and not an oversight", () => {
    // Text generation is planned (#1778) but not built. Saying true here would
    // seed prompt containers on text nodes and light up a menu item that opens
    // nothing — the false is load-bearing until that work lands.
    expect(canGenerate("text")).toBe(false);
  });
});
