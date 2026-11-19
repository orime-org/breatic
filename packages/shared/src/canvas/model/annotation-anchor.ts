// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where a canvas note is pinned (breatic#1488 §11.8). A note stores only its
 * own position, which is the pin's tip (the node's origin is its bottom-left
 * corner); it records no node and does not follow one. So what it is pinned
 * on is read from where things are now, as the user sees it: the nodes whose
 * rect holds the tip, topmost first, and the innermost group holding it.
 */

import { footprintOf, type NodePlacement } from "@shared/canvas/model/place-flow.js";

/** What a note's pin is on. */
export interface AnnotationAnchor {
  /** The nodes under the tip, topmost first; never a group or another note. */
  nodeIds: string[];
  /** The innermost group holding the tip, or null. */
  groupId: string | null;
}

/**
 * Whether a placement's rect holds a point, edges included.
 * @param p - The placement.
 * @param x - The point's x.
 * @param y - The point's y.
 * @returns True when it does.
 */
function holds(p: NodePlacement, x: number, y: number): boolean {
  const { width, height } = footprintOf(p, () => undefined);
  return x >= p.x && x <= p.x + width && y >= p.y && y <= p.y + height;
}

/**
 * What a note is pinned on.
 * @param placements - Every node, in the order the canvas draws them (groups
 *   are drawn first whatever their place; among the rest a later one is on top).
 * @param annotationId - The note.
 * @returns What its pin is on, or null when the id is no note.
 */
export function annotationAnchor(placements: readonly NodePlacement[], annotationId: string): AnnotationAnchor | null {
  const pin = placements.find((p) => p.id === annotationId);
  if (pin?.type !== "annotation") return null;
  const under = placements.filter((p) => p.type !== "annotation" && holds(p, pin.x, pin.y));
  /**
   * A group's area; one nested in another lies wholly inside it, so the innermost is the smallest.
   * @param p - The group.
   * @returns Its area.
   */
  const area = (p: NodePlacement): number => (p.width ?? 0) * (p.height ?? 0);
  const innermost = under.filter((p) => p.type === "group").sort((a, b) => area(a) - area(b))[0];
  return {
    nodeIds: under.filter((p) => p.type !== "group").map((p) => p.id).reverse(),
    groupId: innermost?.id ?? null,
  };
}
