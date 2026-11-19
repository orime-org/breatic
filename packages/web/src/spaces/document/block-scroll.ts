// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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

/** Where following aligned the body, so a later scroll can be told from the user's. */
export interface AlignmentMark {
  /** The scrollTop read back after aligning. */
  target: number;
  /** The block aligned to, or null for a position with no block at the top. */
  blockId: string | null;
  /** Its line's distance below the viewport top, or null when it had no line. */
  offset: number | null;
}

/**
 * A block's own line in the body.
 * @param root - The element to look inside.
 * @param id - The block id.
 * @param fallback - Whether a block with no line of its own falls back to its outer box (the outline) instead of finding nothing.
 * @returns The element, or null when there is none.
 */
export function blockLine(root: HTMLElement, id: string, fallback: boolean): HTMLElement | null {
  const block = root.querySelector<HTMLElement>(`.bn-block-outer[data-id="${CSS.escape(id)}"]`);
  if (block === null) return null;
  return block.querySelector<HTMLElement>(OWN_LINE) ?? (fallback ? block : null);
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
 * @param options - How the block is found and where it lands.
 * @param options.fallback - Whether a block with no line of its own falls back to its outer box; false by default.
 * @param options.landing - How far below the top of the body the line lands; {@link LANDING} by default.
 * @returns The scrollTop, or null when the block is not on the page.
 */
export function scrollTopForBlock(
  viewport: HTMLElement,
  root: HTMLElement,
  id: string,
  { fallback = false, landing = LANDING }: { fallback?: boolean; landing?: number } = {},
): number | null {
  const line = blockLine(root, id, fallback);
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
 * The blocks whose own line is on screen, in document order (#1488 §19.1).
 * Blocks with no line of their own (table, row and cell) are skipped, as
 * `topBlockId` skips them.
 * @param viewport - The body's scrolling viewport.
 * @param root - The body element.
 * @returns Their ids.
 */
export function visibleBlockIds(viewport: HTMLElement, root: HTMLElement): string[] {
  const { top, bottom } = viewport.getBoundingClientRect();
  const ids: string[] = [];
  for (const block of root.querySelectorAll<HTMLElement>('.bn-block-outer[data-id]')) {
    const line = block.querySelector<HTMLElement>(OWN_LINE)?.getBoundingClientRect();
    if (line !== undefined && line.bottom > top && line.top < bottom && block.dataset.id !== undefined) ids.push(block.dataset.id);
  }
  return ids;
}

/**
 * A block's own line, for a mark that may name no block.
 * @param root - The body element.
 * @param blockId - The block, or null.
 * @returns The line, or null when there is none.
 */
function markLine(root: HTMLElement, blockId: string | null): HTMLElement | null {
  return blockId === null ? null : blockLine(root, blockId, false);
}

/**
 * Record where the body stands right after following aligned it to a block,
 * or, given no block, where it stands now by the block at its top.
 * @param viewport - The body's scrolling viewport.
 * @param root - The body element.
 * @param blockId - The block aligned to; the block at the top when left out.
 * @returns The mark.
 */
export function markAlignment(
  viewport: HTMLElement,
  root: HTMLElement,
  blockId: string | null = topBlockId(viewport, root),
): AlignmentMark {
  const line = markLine(root, blockId);
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
  const line = markLine(root, mark.blockId);
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
  const line = markLine(root, mark.blockId);
  return { ...mark, target: viewport.scrollTop, offset: line === null ? mark.offset : distanceBelowTop(viewport, line) };
}
