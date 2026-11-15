// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Locating and scrolling to blocks of a document body, shared by the outline's
 * jumps and following a member (#920).
 *
 * A block is measured by its own line (`:scope > .bn-block > .bn-block-content`),
 * never its `.bn-block-outer`, whose box takes in the space above it and, for a
 * list or a table, every block nested inside.
 */

/** Where a jump leaves a block's line: this far below the top of the body. */
export const LANDING = 16;

/** A block's own line inside its outer box. */
const OWN_LINE = ':scope > .bn-block > .bn-block-content';

/** How a lookup treats a block with no line of its own. */
export interface LineOptions {
  /** Fall back to the block's outer box (the outline) instead of finding nothing. */
  fallback: boolean;
}

/** Where following aligned the body, so a later scroll can be told from the user's. */
export interface AlignmentMark {
  /** The scrollTop read back after aligning. */
  target: number;
  /** The block aligned to. */
  blockId: string;
  /** Its line's distance below the viewport top, or null when it had no line. */
  offset: number | null;
}

/**
 * A block's own line in the body.
 * @param root - The element to look inside.
 * @param id - The block id.
 * @param options - Whether a block with no line of its own falls back to its outer box.
 * @returns The element, or null when there is none.
 */
export function blockLine(root: HTMLElement, id: string, options: LineOptions): HTMLElement | null {
  const block = root.querySelector<HTMLElement>(`.bn-block-outer[data-id="${CSS.escape(id)}"]`);
  if (block === null) return null;
  return block.querySelector<HTMLElement>(OWN_LINE) ?? (options.fallback ? block : null);
}

/**
 * Whether a scroll position is the body's end, give or take 2px.
 * @param viewport - The body's scrolling viewport.
 * @param top - The scroll position; the current one by default.
 * @returns True at the end.
 */
export function atEnd(viewport: HTMLElement, top = viewport.scrollTop): boolean {
  return top + viewport.clientHeight >= viewport.scrollHeight - 2;
}

/**
 * How far a line sits below the viewport's top edge.
 * @param viewport - The body's scrolling viewport.
 * @param line - The line.
 * @returns The distance in pixels.
 */
function distanceBelowTop(viewport: HTMLElement, line: HTMLElement): number {
  return line.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
}

/**
 * Where the body scrolls to for a block: its line at the landing, or the
 * body's end when too little follows it.
 * @param viewport - The body's scrolling viewport.
 * @param root - The element the block is looked up in.
 * @param id - The block id.
 * @param options - Whether a block with no line of its own falls back to its outer box.
 * @param landing - How far below the top of the body the line lands; {@link LANDING} by default.
 * @returns The scrollTop, or null when the block is not on the page.
 */
export function landingFor(
  viewport: HTMLElement,
  root: HTMLElement,
  id: string,
  options: LineOptions = { fallback: false },
  landing = LANDING,
): number | null {
  const line = blockLine(root, id, options);
  if (line === null) return null;
  const want = viewport.scrollTop + distanceBelowTop(viewport, line) - landing;
  return Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, want));
}

/**
 * The block at the top of the viewport: the first, in document order, whose
 * own line ends below the viewport's top. Blocks with no line of their own
 * (table, row and cell) are skipped, so the paragraph inside a cell is taken.
 * @param viewport - The body's scrolling viewport.
 * @param root - The body element.
 * @returns The block id, or null when no block is below the top.
 */
export function topBlockId(viewport: HTMLElement, root: HTMLElement): string | null {
  const top = viewport.getBoundingClientRect().top;
  for (const block of root.querySelectorAll<HTMLElement>('.bn-block-outer[data-id]')) {
    const line = block.querySelector<HTMLElement>(OWN_LINE);
    if (line !== null && line.getBoundingClientRect().bottom > top) return block.dataset.id ?? null;
  }
  return null;
}

/**
 * Record where the body stands right after following aligned it to a block.
 * @param viewport - The body's scrolling viewport.
 * @param root - The body element.
 * @param blockId - The block aligned to.
 * @returns The mark.
 */
export function markAlignment(viewport: HTMLElement, root: HTMLElement, blockId: string): AlignmentMark {
  const line = blockLine(root, blockId, { fallback: false });
  return { target: viewport.scrollTop, blockId, offset: line === null ? null : distanceBelowTop(viewport, line) };
}

/**
 * Whether the body is still where following put it: scrollTop at the mark
 * (clamped to a body that got shorter), or the block's line at the same
 * distance from the top (scroll anchoring after content above changed).
 * Anything else is the user scrolling.
 * @param viewport - The body's scrolling viewport.
 * @param root - The body element.
 * @param mark - The last accepted position.
 * @returns True while aligned.
 */
export function stillAligned(viewport: HTMLElement, root: HTMLElement, mark: AlignmentMark): boolean {
  const max = viewport.scrollHeight - viewport.clientHeight;
  if (Math.abs(viewport.scrollTop - Math.min(mark.target, max)) < 1) return true;
  if (mark.offset === null) return false;
  const line = blockLine(root, mark.blockId, { fallback: false });
  return line !== null && Math.abs(distanceBelowTop(viewport, line) - mark.offset) < 1;
}

/**
 * Move a mark to the position just accepted, so a clamp and an anchoring
 * adjustment that follow each other are each judged against the last.
 * @param viewport - The body's scrolling viewport.
 * @param root - The body element.
 * @param mark - The mark accepted by `stillAligned`.
 * @returns The mark at the current position; the old offset when the block is gone.
 */
export function rebaseMark(viewport: HTMLElement, root: HTMLElement, mark: AlignmentMark): AlignmentMark {
  const line = blockLine(root, mark.blockId, { fallback: false });
  return { ...mark, target: viewport.scrollTop, offset: line === null ? mark.offset : distanceBelowTop(viewport, line) };
}
