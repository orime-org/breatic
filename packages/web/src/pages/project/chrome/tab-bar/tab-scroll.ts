// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** A stretch of the tab strip, in the scroller's own coordinates. */
export interface Span {
  /** Its leading edge. */
  start: number;
  /** Its trailing edge. */
  end: number;
}

/** Absorbs sub-pixel rounding from CSS gap and padding. */
const EDGE_TOLERANCE = 1;

/**
 * Whether a tab reaches past the strip's leading edge.
 * @param span - Where the tab sits.
 * @param span.start - Its leading edge.
 * @param visible - What stretch of the strip is on screen.
 * @param visible.start - The strip's leading edge.
 * @returns True when part of it is off to the left.
 */
export function startsBefore(
  span: { start: number },
  visible: { start: number },
): boolean {
  return span.start < visible.start - EDGE_TOLERANCE;
}

/**
 * Whether a tab reaches past the strip's trailing edge.
 * @param span - Where the tab sits.
 * @param span.end - Its trailing edge.
 * @param visible - What stretch of the strip is on screen.
 * @param visible.end - The strip's trailing edge.
 * @returns True when part of it is off to the right.
 */
export function endsAfter(
  span: { end: number },
  visible: { end: number },
): boolean {
  return span.end > visible.end + EDGE_TOLERANCE;
}

/**
 * Where the strip sits with a tab flush against one of its edges.
 * @param span - Where the tab sits.
 * @param visible - What stretch of the strip is on screen.
 * @param edge - Which edge of the strip the tab should end up against.
 * @returns The scroll position that puts it there.
 */
export function edgeLanding(
  span: Span,
  visible: Span,
  edge: 'start' | 'end',
): number {
  return edge === 'end'
    ? span.end - (visible.end - visible.start)
    : span.start;
}

/**
 * Where the strip has to scroll to show a tab as far as it can, or null when
 * it is already there.
 *
 * The enabled state of the reveal control and the scroll a click performs are
 * both this one answer, so the question it is enabled by cannot disagree with
 * what clicking it does. A tab wider than the strip can never be whole on
 * screen; asking for that left each click swinging scrollLeft between two
 * positions forever, measured in a browser at 137px of strip and a 160px tab.
 * Such a tab lands with its start against the leading edge.
 * @param span - Where the tab sits.
 * @param visible - What stretch of the strip is on screen.
 * @returns The scroll position to move to, or null when nothing more can be
 *   brought into view.
 */
export function scrollTargetFor(span: Span, visible: Span): number | null {
  const edge = landingEdge(span, visible);
  if (edge === null) return null;
  const landing = edgeLanding(span, visible, edge);
  return Math.abs(landing - visible.start) <= EDGE_TOLERANCE ? null : landing;
}

/**
 * Which edge a tab has to come to rest against, or null when it needs neither.
 * @param span - Where the tab sits.
 * @param visible - What stretch of the strip is on screen.
 * @returns The edge, or null.
 */
function landingEdge(span: Span, visible: Span): 'start' | 'end' | null {
  if (span.end - span.start > visible.end - visible.start) return 'start';
  if (endsAfter(span, visible)) return 'end';
  if (startsBefore(span, visible)) return 'start';
  return null;
}
