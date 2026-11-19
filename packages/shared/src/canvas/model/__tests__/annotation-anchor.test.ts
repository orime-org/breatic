// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { annotationAnchor } from "@shared/canvas/model/annotation-anchor.js";
import { EMPTY_NODE_SIZE } from "@shared/canvas/model/group-geometry.js";
import type { NodePlacement } from "@shared/canvas/model/place-flow.js";

/**
 * A node at a point.
 * @param id - Its id.
 * @param type - Its type.
 * @param x - Left edge.
 * @param y - Top edge.
 * @param size - A Group's own size.
 * @returns The placement.
 */
function at(id: string, type: string, x: number, y: number, size?: { width: number; height: number }): NodePlacement {
  return { id, type, x, y, ...size };
}

describe("annotationAnchor", () => {
  it("lists the nodes under the pin's tip, topmost first, and the group it is in", () => {
    const placements = [
      at("frame", "group", -100, -100, { width: 1000, height: 1000 }),
      at("below", "image", 0, 0),
      at("above", "text", 10, 10),
      at("away", "image", 5000, 5000),
      at("pin", "annotation", 20, 20),
    ];
    expect(annotationAnchor(placements, "pin")).toEqual({ nodeIds: ["above", "below"], groupId: "frame" });
  });

  it("names no node and no group for a pin on empty canvas", () => {
    expect(annotationAnchor([at("n", "image", 0, 0), at("pin", "annotation", 2000, 2000)], "pin")).toEqual({ nodeIds: [], groupId: null });
  });

  it("counts a node's edge as inside it, and never another note", () => {
    const placements = [at("n", "image", 0, 0), at("other", "annotation", EMPTY_NODE_SIZE.width, 0), at("pin", "annotation", EMPTY_NODE_SIZE.width, 0)];
    expect(annotationAnchor(placements, "pin")).toEqual({ nodeIds: ["n"], groupId: null });
  });

  it("answers null for an id that is no note", () => {
    expect(annotationAnchor([at("n", "image", 0, 0)], "n")).toBeNull();
    expect(annotationAnchor([], "missing")).toBeNull();
  });

  it("names the innermost of nested groups, in whatever order they come", () => {
    const outer = at("outer", "group", 0, 0, { width: 1000, height: 1000 });
    const inner = at("inner", "group", 100, 100, { width: 300, height: 300 });
    const pin = at("pin", "annotation", 150, 150);
    expect(annotationAnchor([outer, inner, pin], "pin")?.groupId).toBe("inner");
    expect(annotationAnchor([inner, outer, pin], "pin")?.groupId).toBe("inner");
  });
});
