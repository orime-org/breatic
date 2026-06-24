// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pure Group geometry — membership hit-testing, parent/child coordinate
 * conversion, and the Group's authoritative-size math. ReactFlow-agnostic so
 * the math is unit-tested in isolation; the canvas wires these into the
 * drag-stop / resize / create handlers.
 *
 * Replaces the auto-container model (`group-geometry.ts`) where a group's box
 * was DERIVED from its members. A Group owns its size; these helpers decide
 * membership by the member's center point and grow the Group only-up (never
 * auto-shrink) when an in-group member overflows.
 */

/** A point in canvas (flow) coordinates. */
export interface Point {
  x: number;
  y: number;
}

/** A bounding rectangle in canvas (flow) coordinates. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Minimum breathing room (px) the Group keeps between its border and every
 * member, on every side, at all times — applied at creation
 * ({@link groupRectForMembers}), on auto-expand ({@link expandGroupToWrap}), and
 * as the manual-resize hard-stop ({@link containsWithPadding}).
 */
export const GROUP_PADDING = 24;

/** Smallest a Group may be manually resized to when it holds no members. */
export const GROUP_MIN_SIZE = 40;

/**
 * The center point of a rect.
 * @param rect - The rectangle.
 * @returns Its geometric center.
 */
function centerOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * Whether `point` lies within `rect` (edges inclusive).
 * @param rect - The rectangle.
 * @param point - The point to test.
 * @returns True when the point is inside or on the edge of the rect.
 */
export function rectContainsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * Whether the member belongs to the Group, decided by the member's CENTER
 * point (not its whole body). This is the single membership rule: on drag-stop
 * a member whose center is inside the Group stays in (even if its body sticks
 * out — the Group then auto-expands, see {@link expandGroupToWrap}); a member
 * whose center crosses the Group edge leaves.
 * @param group - The Group's authoritative rect.
 * @param member - The member's rect (absolute canvas coordinates).
 * @returns True when the member's center is inside the Group.
 */
export function groupContainsMemberCenter(group: Rect, member: Rect): boolean {
  return rectContainsPoint(group, centerOf(member));
}

/**
 * Convert an absolute canvas position to one relative to a parent Group's
 * top-left (the form ReactFlow stores for a parented node).
 * @param abs - The absolute position.
 * @param parentTopLeft - The parent Group's top-left position.
 * @returns The position relative to the parent.
 */
export function toRelativePosition(abs: Point, parentTopLeft: Point): Point {
  return { x: abs.x - parentTopLeft.x, y: abs.y - parentTopLeft.y };
}

/**
 * Convert a parent-relative position back to absolute canvas coordinates (used
 * when a member leaves its Group and becomes top-level again).
 * @param rel - The parent-relative position.
 * @param parentTopLeft - The parent Group's top-left position.
 * @returns The absolute position.
 */
export function toAbsolutePosition(rel: Point, parentTopLeft: Point): Point {
  return { x: rel.x + parentTopLeft.x, y: rel.y + parentTopLeft.y };
}

/**
 * The initial Group rect that wraps the given members with padding on every
 * side — used when a Group is created around a selection.
 * @param members - The selected members' rects (absolute coordinates).
 * @param padding - Padding added on every side (default {@link GROUP_PADDING}).
 * @returns The padded bounding rect, or `null` when there are no members.
 */
export function groupRectForMembers(
  members: ReadonlyArray<Rect>,
  padding: number = GROUP_PADDING,
): Rect | null {
  if (members.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const m of members) {
    minX = Math.min(minX, m.x);
    minY = Math.min(minY, m.y);
    maxX = Math.max(maxX, m.x + m.width);
    maxY = Math.max(maxY, m.y + m.height);
  }
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + 2 * padding,
    height: maxY - minY + 2 * padding,
  };
}

/**
 * Grow the Group so it wraps all the given members with `padding` breathing room
 * on every side, expanding only — the result always contains the original Group
 * rect, so it never auto-shrinks when members move or leave (user-driven
 * `NodeResizer` is the only way to shrink). Implemented as the union of the
 * Group's own corners with every member's corners inflated by `padding`, so a
 * member that drifts within `padding` of an edge (or overflows it) pushes the
 * Group out to restore the gap.
 * @param group - The Group's current rect.
 * @param members - The in-group members' rects (absolute coordinates).
 * @param padding - Breathing room kept around each member (default {@link GROUP_PADDING}).
 * @returns A rect containing the original Group and every member padded by `padding`.
 */
export function expandGroupToWrap(
  group: Rect,
  members: ReadonlyArray<Rect>,
  padding: number = GROUP_PADDING,
): Rect {
  let minX = group.x;
  let minY = group.y;
  let maxX = group.x + group.width;
  let maxY = group.y + group.height;
  for (const m of members) {
    minX = Math.min(minX, m.x - padding);
    minY = Math.min(minY, m.y - padding);
    maxX = Math.max(maxX, m.x + m.width + padding);
    maxY = Math.max(maxY, m.y + m.height + padding);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** One Group + the absolute rects of all its members (existing + newly added). */
export interface GroupGrowthInput {
  groupId: string;
  /** The Group's current absolute rect. */
  rect: Rect;
  /** Every member's absolute rect (existing members plus any just added). */
  memberRects: ReadonlyArray<Rect>;
}

/** A Group that must grow to keep {@link GROUP_PADDING} around its members. */
export interface GroupGrowth {
  groupId: string;
  position: Point;
  width: number;
  height: number;
}

/**
 * For each Group, the new size it must grow to so every member keeps
 * {@link GROUP_PADDING} inside — used when a duplicate drops a clone into an
 * existing Group (R2-A): the new member could sit flush against (or past) the
 * border, so the Group expands (only-up, via {@link expandGroupToWrap}) to
 * restore the breathing room. Only Groups that actually grew are returned, so
 * the caller writes nothing for a Group that already had room.
 * @param groups - Each Group with its current rect + all member absolute rects.
 * @returns One {@link GroupGrowth} per Group whose size changed.
 */
export function planGroupGrowth(
  groups: ReadonlyArray<GroupGrowthInput>,
): GroupGrowth[] {
  const out: GroupGrowth[] = [];
  for (const group of groups) {
    const grown = expandGroupToWrap(group.rect, group.memberRects);
    if (
      grown.x === group.rect.x &&
      grown.y === group.rect.y &&
      grown.width === group.rect.width &&
      grown.height === group.rect.height
    ) {
      continue;
    }
    out.push({
      groupId: group.groupId,
      position: { x: grown.x, y: grown.y },
      width: grown.width,
      height: grown.height,
    });
  }
  return out;
}

/** The 8 NodeResizer control positions: 4 edge lines + 4 corner handles. */
export type GroupControlPosition =
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

/** One resize control's member-derived minimum size. */
export interface GroupResizeBound {
  position: GroupControlPosition;
  minWidth: number;
  minHeight: number;
}

/**
 * Per-control minimum width/height so ReactFlow's NATIVE resize clamp keeps every
 * member ≥ `padding` inside the Group on the dragged side, with a true hard-stop
 * (no `shouldResize` veto, no post-commit repair). Each control anchors its
 * OPPOSITE edge, so a coordinate hard-stop ("don't cross member ± padding")
 * collapses into a pure size floor: the `right` line keeps the left edge fixed,
 * so "stay ≥ padding right of the rightmost member" is `minWidth = mRight +
 * padding`; the `left` line keeps the right edge (at local `width`) fixed, so it
 * is `minWidth = width − mLeft + padding`. The dimension an edge control does not
 * move takes the empty floor `minSize` (it never binds). An empty Group (no
 * `membersBox`) floors every control at `minSize`. Every derived bound is also
 * floored at `minSize` so a member hugging the origin can't yield a sub-floor min.
 * @param membersBox - The members' bounding box in GROUP-LOCAL coords (relative to the Group top-left), or null when empty.
 * @param width - The Group's current width (anchors the left/top size translation).
 * @param height - The Group's current height.
 * @param padding - The breathing room kept inside every edge.
 * @param minSize - The absolute floor (empty-group min + floor for every derived bound).
 * @returns One {@link GroupResizeBound} per control (4 edge lines + 4 corner handles).
 */
export function groupResizeBounds(
  membersBox: Rect | null,
  width: number,
  height: number,
  padding: number,
  minSize: number,
): GroupResizeBound[] {
  const POSITIONS: GroupControlPosition[] = [
    'right',
    'left',
    'bottom',
    'top',
    'top-left',
    'top-right',
    'bottom-left',
    'bottom-right',
  ];
  if (membersBox === null) {
    return POSITIONS.map((position) => ({
      position,
      minWidth: minSize,
      minHeight: minSize,
    }));
  }
  const mLeft = membersBox.x;
  const mTop = membersBox.y;
  const mRight = membersBox.x + membersBox.width;
  const mBottom = membersBox.y + membersBox.height;
  /**
   * Clamp a derived bound up to the empty-group floor `minSize`.
   * @param value - The member-derived bound.
   * @returns The greater of `value` and `minSize`.
   */
  const floor = (value: number): number => Math.max(value, minSize);
  // Member-side size floor per axis: anchoring the opposite edge turns each
  // "member ± padding" coordinate stop into a size minimum.
  const minWFromRight = floor(mRight + padding); // left edge anchored
  const minWFromLeft = floor(width - mLeft + padding); // right edge anchored
  const minHFromBottom = floor(mBottom + padding); // top edge anchored
  const minHFromTop = floor(height - mTop + padding); // bottom edge anchored
  return [
    { position: 'right', minWidth: minWFromRight, minHeight: minSize },
    { position: 'left', minWidth: minWFromLeft, minHeight: minSize },
    { position: 'bottom', minWidth: minSize, minHeight: minHFromBottom },
    { position: 'top', minWidth: minSize, minHeight: minHFromTop },
    { position: 'top-left', minWidth: minWFromLeft, minHeight: minHFromTop },
    { position: 'top-right', minWidth: minWFromRight, minHeight: minHFromTop },
    { position: 'bottom-left', minWidth: minWFromLeft, minHeight: minHFromBottom },
    { position: 'bottom-right', minWidth: minWFromRight, minHeight: minHFromBottom },
  ];
}
