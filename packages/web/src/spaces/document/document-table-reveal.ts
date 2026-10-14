// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Scrolls the wide table holding some words sideways just far enough to show
 * them. A table wider than the column scrolls inside its own frame
 * (`DocumentTableScroller`), which scrolling the body up and down never moves.
 * Computed against that frame from the two rectangles, as `scrollTabToEdge`
 * does; words wider than the frame show from their start.
 * @param target - The words, in the body.
 */
export function revealInTable(target: HTMLElement): void {
  const viewport = target
    .closest('.doc-table-scroller')
    ?.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]');
  if (viewport === null || viewport === undefined) return;
  const frame = viewport.getBoundingClientRect();
  const at = target.getBoundingClientRect();
  const by =
    at.left < frame.left
      ? at.left - frame.left
      : Math.min(Math.max(at.right - frame.right, 0), at.left - frame.left);
  if (by !== 0) viewport.scrollTo({ left: viewport.scrollLeft + by, behavior: 'instant' });
}
