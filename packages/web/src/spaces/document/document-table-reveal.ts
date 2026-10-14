// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Scrolls the wide table holding some words sideways just far enough to show
 * the cell they are in, clear of the frame's "more to scroll" edges. A table
 * wider than the column scrolls inside its own frame (`DocumentTableScroller`),
 * which scrolling the body up and down never moves. Computed against that
 * frame from the two rectangles, as `scrollTabToEdge` does; a cell wider than
 * the frame shows from its start.
 * @param target - The words, in the body.
 */
export function revealInTable(target: HTMLElement): void {
  const frame = target.closest('.doc-table-frame');
  const viewport = frame?.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]');
  if (frame === null || frame === undefined || viewport === null || viewport === undefined) return;
  const edge = frame.querySelector<HTMLElement>('.doc-table-overflow-edge')?.offsetWidth ?? 0;
  const cell = target.closest<HTMLElement>('td, th') ?? target;
  const box = viewport.getBoundingClientRect();
  const at = cell.getBoundingClientRect();
  const left = box.left + edge;
  const right = box.right - edge;
  const by = at.left < left ? at.left - left : Math.min(Math.max(at.right - right, 0), at.left - left);
  if (by !== 0) viewport.scrollTo({ left: viewport.scrollLeft + by, behavior: 'instant' });
}
