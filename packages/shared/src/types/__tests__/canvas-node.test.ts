// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which node modalities offer Generate (#1896).
 *
 * `canGenerate` gates two things that must agree: whether the canvas offers
 * the Generate menu item on a node, and whether creating a node seeds the
 * prompt container that a generation recipe is written into. A modality that
 * answers true here must be usable end to end, because a node created under a
 * true answer carries a prompt container forever after.
 *
 * These cases pin the list itself, and the last one makes them exhaustive over
 * `NodeType` in a way the compiler enforces: a new modality added to the union
 * without a decision here fails to build, because "does this modality
 * generate" is a product decision and not something a reader should have to
 * infer from the absence of a case.
 */

import { describe, it, expect } from "vitest";

import { canGenerate } from "@shared/types/canvas-node";
import type { NodeType } from "@shared/types/canvas-node";

/** Every value of `NodeType`, so the two lists below cover the union. */
const GENERATES: readonly NodeType[] = ["image", "video", "audio"];
const DOES_NOT: readonly NodeType[] = [
  "text",
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
    // `as const` is what makes this more than a restatement of the two lists
    // above. A plain `readonly NodeType[]` annotation only checks that each
    // element IS a NodeType, so a hand-written array stays valid — and this
    // assertion stays green — after the union grows. Narrowed to its literals
    // instead, `Uncovered` names whatever the union has that this array does
    // not, and the line after it stops compiling with that name in the error.
    const everyType = [
      "text",
      "image",
      "audio",
      "video",
      "3d",
      "web",
      "annotation",
      "group",
    ] as const satisfies readonly NodeType[];

    type Uncovered = Exclude<NodeType, (typeof everyType)[number]>;
    // Wrapped in a tuple so `never` is compared, not distributed over (a bare
    // `Uncovered extends never` resolves to `never`, which nothing satisfies).
    const uncovered: [Uncovered] extends [never] ? "none" : Uncovered = "none";
    expect(uncovered).toBe("none");

    const decided = [...GENERATES, ...DOES_NOT];
    expect([...decided].sort()).toEqual([...everyType].sort());
  });

  it("says text does not generate yet, which is a decision and not an oversight", () => {
    // Text generation is planned (#1778) but not built. Saying true here would
    // seed prompt containers on text nodes and light up a menu item that opens
    // nothing — the false is load-bearing until that work lands.
    expect(canGenerate("text")).toBe(false);
  });
});
