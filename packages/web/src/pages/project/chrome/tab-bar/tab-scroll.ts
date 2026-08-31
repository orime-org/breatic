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
 * How much of a tab the strip currently shows.
 * @param span - Where the tab sits.
 * @param visible - What stretch of the strip is on screen.
 * @returns The length on screen, negative when the tab is off it entirely.
 */
function shownLength(span: Span, visible: Span): number {
  return Math.min(span.end, visible.end) - Math.max(span.start, visible.start);
}

/**
 * Whether the strip already shows as much of a tab as it can hold.
 *
 * One question for both shapes: a tab narrower than the strip has to be whole,
 * and a tab wider than it has to fill it. Every scroll position that fills the
 * strip shows the same amount, so all of them answer yes — naming one of them
 * as the place such a tab belongs left the reveal control lit right after the
 * right arrow had parked it at another one, and clicking it threw the strip
 * back. Measured in a browser at 137px of strip and a 160px tab.
 * @param span - Where the tab sits.
 * @param visible - What stretch of the strip is on screen.
 * @returns True when scrolling cannot show any more of it.
 */
function fullyShown(span: Span, visible: Span): boolean {
  const most = Math.min(span.end - span.start, visible.end - visible.start);
  return shownLength(span, visible) >= most - EDGE_TOLERANCE;
}

/**
 * Where the strip has to scroll to show a tab as far as it can, or null when
 * it is already there.
 *
 * The enabled state of the reveal control and the scroll a click performs are
 * both this one answer, so the question it is enabled by cannot disagree with
 * what clicking it does.
 * @param span - Where the tab sits.
 * @param visible - What stretch of the strip is on screen.
 * @returns The scroll position to move to, or null when nothing more can be
 *   brought into view.
 */
export function scrollTargetFor(span: Span, visible: Span): number | null {
  if (fullyShown(span, visible)) return null;
  return edgeLanding(span, visible, landingEdge(span, visible));
}

/**
 * Which edge a tab has to come to rest against to show more of itself.
 *
 * A tab wider than the strip is read from its start. A narrower one moves the
 * short way: toward whichever edge is cutting it off.
 * @param span - Where the tab sits.
 * @param visible - What stretch of the strip is on screen.
 * @returns The edge to bring it flush against.
 */
function landingEdge(span: Span, visible: Span): 'start' | 'end' {
  if (span.end - span.start > visible.end - visible.start) return 'start';
  return endsAfter(span, visible) ? 'end' : 'start';
}
