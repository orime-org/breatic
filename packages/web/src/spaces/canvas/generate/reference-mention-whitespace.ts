// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Whitespace anchor model for reference chips — the pure core of the caret fix.
 *
 * Root cause (browser-engine layer, confirmed by real-machine experiments): a
 * reference chip is an inline uneditable atom; a caret position immediately next
 * to it is a real document position (typing lands there) but the DOM has no
 * adjacent TEXT node, so at a soft-wrap boundary the browser cannot use caret
 * affinity (UPSTREAM/DOWNSTREAM) to disambiguate and snaps the caret to the next
 * line — plus IME has no compose host and the native pointer mis-hits the gap.
 *
 * Fix: keep one visible ordinary space (U+0020, a real text node) on every side
 * of every chip. A real space restores full text-caret semantics (affinity, font
 * height, IME host) that an img/ZWSP anchor cannot. This module holds the two
 * pure planners; the ProseMirror plugin wiring (appendTransaction + handleKeyDown)
 * lives in reference-mention-caret.ts.
 *
 * Two mechanisms, orthogonal:
 * - {@link planWhitespaceInsertions} — the ADDITIVE structural invariant: after
 *   any edit, add the spaces a chip is missing (only-adds, idempotent). Covers
 *   insert / paste / collab / @ / click-insert.
 * - {@link resolveDeletionUnit} — DELETION consistency: a chip + its exclusive
 *   owned spaces delete as one atomic unit, so deleting a chip leaves no residue
 *   and its surrounding space is never "un-deletable" (re-added by the invariant).
 *   A space shared with an adjacent chip stays for the neighbour.
 */

import type { Node as PMNode } from '@tiptap/pm/model';

import { REFERENCE_MENTION_NODE } from '@web/spaces/canvas/generate/at-reference';

/** An inclusive-from / exclusive-to document range. */
export interface DocRange {
  /** Range start (inclusive). */
  from: number;
  /** Range end (exclusive). */
  to: number;
}

/**
 * Whether a node is a reference-mention chip.
 * @param node - The node to test (null at an edge).
 * @returns True for a reference-mention atom.
 */
export function isChip(node: PMNode | null): node is PMNode {
  return node?.type.name === REFERENCE_MENTION_NODE;
}

/**
 * Whether the single character occupying `[from, from+1]` is an ordinary space
 * (U+0020). False for a chip, a non-space char, or an out-of-range / block
 * boundary (where `textBetween` yields '').
 * @param doc - The document node.
 * @param from - The position whose following character is inspected.
 * @returns True when that character is a U+0020.
 */
export function isSpaceAt(doc: PMNode, from: number): boolean {
  if (from < 0 || from + 1 > doc.content.size) return false;
  return doc.textBetween(from, from + 1) === ' ';
}

/**
 * The reference chip that STARTS at `from` (occupies `[from, from+1]`), or null.
 * @param doc - The document node.
 * @param from - The candidate chip start position.
 * @returns The chip node there, or null.
 */
export function chipAt(doc: PMNode, from: number): PMNode | null {
  if (from < 0 || from >= doc.content.size) return null;
  const node = doc.nodeAt(from);
  return isChip(node) ? node : null;
}

/**
 * Positions where a U+0020 must be inserted so every reference chip has a space
 * on each side (including paragraph start / end). Returned DESCENDING and DEDUPED
 * so a caller inserting a space at each position in order never shifts an earlier
 * (lower) position, and two adjacent chips SHARE a single inserted space (the
 * left chip's right-gap and the right chip's left-gap are the same position, so
 * the Set collapses them to one). Idempotent: a doc already satisfying the
 * invariant returns `[]`.
 * @param doc - The document node.
 * @returns Insertion positions, descending and deduped.
 */
export function planWhitespaceInsertions(doc: PMNode): number[] {
  const positions = new Set<number>();
  doc.descendants((node, pos) => {
    if (!isChip(node)) return;
    const right = pos + node.nodeSize; // char slot immediately after the chip
    if (!isSpaceAt(doc, pos - 1)) positions.add(pos); // left gap
    if (!isSpaceAt(doc, right)) positions.add(right); // right gap
  });
  return [...positions].sort((a, b) => b - a);
}

/**
 * The atomic deletion-unit range for the chip starting at `chipPos`: the chip
 * plus its EXCLUSIVE owned spaces. A neighbouring space is exclusive when the
 * cell beyond it is NOT another chip; a space shared with an adjacent chip is
 * kept (so the neighbour keeps its anchor).
 * @param doc - The document node.
 * @param chipPos - The chip's start position.
 * @returns The `[from, to)` range to delete as one unit.
 */
export function chipDeletionUnit(doc: PMNode, chipPos: number): DocRange {
  let from = chipPos;
  let to = chipPos + 1;
  // Left space at [chipPos-1, chipPos]: exclusive unless a chip sits before it.
  if (isSpaceAt(doc, chipPos - 1) && chipAt(doc, chipPos - 2) === null) {
    from = chipPos - 1;
  }
  // Right space at [chipPos+1, chipPos+2]: exclusive unless a chip sits after it.
  if (isSpaceAt(doc, chipPos + 1) && chipAt(doc, chipPos + 2) === null) {
    to = chipPos + 2;
  }
  return { from, to };
}

/**
 * The chip a BACKWARD (Backspace) delete at `pos` targets: the chip directly
 * before the cursor, or the chip owning the space directly before the cursor.
 * For a space shared by two chips, the LEFT chip is targeted (backspace deletes
 * leftward); its exclusive spaces go, the shared one stays for the right chip.
 * @param doc - The document node.
 * @param pos - The collapsed cursor position.
 * @returns The target chip's start position, or null (native delete).
 */
function targetChipBackward(doc: PMNode, pos: number): number | null {
  if (chipAt(doc, pos - 1) !== null) return pos - 1;
  if (isSpaceAt(doc, pos - 1)) {
    if (chipAt(doc, pos - 2) !== null) return pos - 2; // space is that chip's RIGHT
    if (chipAt(doc, pos) !== null) return pos; // space is this chip's LEFT
  }
  return null;
}

/**
 * The chip a FORWARD (Delete) delete at `pos` targets: the chip directly after
 * the cursor, or the chip owning the space directly after the cursor. For a
 * shared space, the RIGHT chip is targeted (delete deletes rightward).
 * @param doc - The document node.
 * @param pos - The collapsed cursor position.
 * @returns The target chip's start position, or null (native delete).
 */
function targetChipForward(doc: PMNode, pos: number): number | null {
  if (chipAt(doc, pos) !== null) return pos;
  if (isSpaceAt(doc, pos)) {
    if (chipAt(doc, pos + 1) !== null) return pos + 1; // space is that chip's LEFT
    if (chipAt(doc, pos - 1) !== null) return pos - 1; // space is this chip's RIGHT
  }
  return null;
}

/**
 * Resolves the deletion-unit range for a collapsed delete that lands on a chip
 * or a chip's exclusive owned space, so a chip + its owned spaces delete as one
 * (no residue, no "un-deletable" space). Returns null when the delete is not
 * chip-related — the caller then lets native deletion proceed.
 * @param doc - The document node.
 * @param pos - The collapsed cursor position.
 * @param dir - Delete direction: 'backward' (Backspace) or 'forward' (Delete).
 * @returns The `[from, to)` range to delete as a unit, or null for native.
 */
export function resolveDeletionUnit(
  doc: PMNode,
  pos: number,
  dir: 'backward' | 'forward',
): DocRange | null {
  const chipPos =
    dir === 'backward'
      ? targetChipBackward(doc, pos)
      : targetChipForward(doc, pos);
  return chipPos === null ? null : chipDeletionUnit(doc, chipPos);
}

/**
 * Deletion ranges for a CASCADE clear — an edge left the pool, so its @-chips
 * must all go. Like {@link chipDeletionUnit} but for a SET of chips at once: each
 * stale chip is removed with its owned spaces; a space shared with ANOTHER STALE
 * chip is also removed, a space shared with a SURVIVING chip is kept (so the
 * survivor keeps its anchor). This makes the cascade path leave no orphan space,
 * matching the keyboard deletion-unit path. Ranges are descending and merged, so
 * a caller can `tr.delete` each in order without shifting the rest.
 * @param doc - The document node.
 * @param stalePositions - Start positions of the chips being cascaded away.
 * @returns The merged `[from, to)` ranges to delete, descending.
 */
export function planCascadeDeletion(
  doc: PMNode,
  stalePositions: ReadonlySet<number>,
): DocRange[] {
  const ranges: DocRange[] = [];
  for (const p of stalePositions) {
    let from = p;
    let to = p + 1;
    // Left space at [p-1, p]: keep only if the chip beyond it SURVIVES.
    if (isSpaceAt(doc, p - 1)) {
      const survives = chipAt(doc, p - 2) !== null && !stalePositions.has(p - 2);
      if (!survives) from = p - 1;
    }
    // Right space at [p+1, p+2]: keep only if the chip beyond it SURVIVES.
    if (isSpaceAt(doc, p + 1)) {
      const survives = chipAt(doc, p + 2) !== null && !stalePositions.has(p + 2);
      if (!survives) to = p + 2;
    }
    ranges.push({ from, to });
  }
  ranges.sort((a, b) => b.from - a.from); // descending
  const merged: DocRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && r.to >= last.from) {
      last.from = Math.min(last.from, r.from);
      last.to = Math.max(last.to, r.to);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}
