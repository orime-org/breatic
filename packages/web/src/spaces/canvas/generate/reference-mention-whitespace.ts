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
import type { Transaction } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';

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
 * Whether the cursor may rest at `pos` under the D model: an owned space is
 * TRANSPARENT to the cursor, so the cursor only stops on the side of an owned
 * space AWAY from its chip. A shared space (chip on both sides) is treated as the
 * RIGHT chip's left owned space, so the cursor stops only on its left.
 *
 * The three UNstoppable shapes (the cursor may never sit on the chip side of an
 * owned space) are:
 * - `text␣|▢` — right neighbour is a chip AND left neighbour is a space; OR
 * - `▢|␣text` — left neighbour is a chip AND right neighbour is an owned
 *   (non-shared) space, i.e. the cell past the space is NOT another chip; and the
 *   derived `▢␣|▢` (after a shared space, before the next chip) which reduces to
 *   the first shape and therefore "does not exist" as a resting position.
 * Everything else — plain text, paragraph start / end, and the three stoppable
 * shapes `text/line-start/para-start|␣▢`, `▢|␣▢` (shared), `▢␣|text/para-end/line-end` — is stoppable.
 * @param doc - The document node.
 * @param pos - The candidate inline cursor position.
 * @returns True when the cursor may rest at `pos`.
 */
export function isStoppable(doc: PMNode, pos: number): boolean {
  // `text␣|▢` / `▢␣|▢`: right neighbour is a chip, left neighbour is a space.
  if (chipAt(doc, pos) !== null && isSpaceAt(doc, pos - 1)) return false;
  // `▢|␣text`: left neighbour is a chip, right is its exclusive (non-shared) space.
  if (
    chipAt(doc, pos - 1) !== null &&
    isSpaceAt(doc, pos) &&
    chipAt(doc, pos + 1) === null
  ) {
    return false;
  }
  return true;
}

/**
 * The next stoppable position from `pos` in the given direction, within the same
 * textblock — an arrow key crosses a chip (and its transparent owned spaces) in a
 * single step by skipping the unstoppable positions between stoppable ones.
 * Returns null at a textblock boundary so the caller lets native handling move
 * across paragraphs.
 * @param doc - The document node.
 * @param pos - The current cursor position.
 * @param dir - 'forward' (ArrowRight) or 'backward' (ArrowLeft).
 * @returns The next stoppable position, or null at the textblock edge.
 */
export function findNextStoppable(
  doc: PMNode,
  pos: number,
  dir: 'backward' | 'forward',
): number | null {
  const $pos = doc.resolve(pos);
  if (!$pos.parent.inlineContent) return null;
  const start = $pos.start();
  const end = $pos.end();
  const step = dir === 'forward' ? 1 : -1;
  for (let p = pos + step; p >= start && p <= end; p += step) {
    if (isStoppable(doc, p)) return p;
  }
  return null;
}

/**
 * The stoppable position nearest to `pos` (left preferred on a tie), used to snap
 * a programmatic / pointer landing (an @ insertion, a collab or command
 * selection, a click) off an unstoppable position onto a valid resting place.
 * Returns `pos` unchanged when it is already stoppable, or null when `pos` is not
 * inline content.
 * @param doc - The document node.
 * @param pos - The landed cursor position.
 * @returns The nearest stoppable position, or null for a non-inline position.
 */
export function nearestStoppable(doc: PMNode, pos: number): number | null {
  if (isStoppable(doc, pos)) return pos;
  const $pos = doc.resolve(pos);
  if (!$pos.parent.inlineContent) return null;
  const start = $pos.start();
  const end = $pos.end();
  const reach = Math.max(pos - start, end - pos);
  for (let d = 1; d <= reach; d += 1) {
    if (pos - d >= start && isStoppable(doc, pos - d)) return pos - d;
    if (pos + d <= end && isStoppable(doc, pos + d)) return pos + d;
  }
  return null;
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
 * kept (so the neighbour keeps its anchor). SPECIAL CASE — a DOUBLE-shared chip
 * (a chip on BOTH sides, e.g. the middle of three adjacent chips): deleting only
 * the chip would leave the two now-adjacent neighbours with TWO spaces between
 * them, which the additive {@link planWhitespaceInsertions} can never heal (it
 * only adds). So absorb the RIGHT shared space too; the LEFT shared space stays
 * as the neighbours' single shared space, preserving the "adjacent chips share
 * ONE space" invariant.
 * @param doc - The document node.
 * @param chipPos - The chip's start position.
 * @returns The `[from, to)` range to delete as one unit.
 */
export function chipDeletionUnit(doc: PMNode, chipPos: number): DocRange {
  let from = chipPos;
  let to = chipPos + 1;
  const leftShared =
    isSpaceAt(doc, chipPos - 1) && chipAt(doc, chipPos - 2) !== null;
  const rightShared =
    isSpaceAt(doc, chipPos + 1) && chipAt(doc, chipPos + 2) !== null;
  // Left space at [chipPos-1, chipPos]: exclusive unless a chip sits before it.
  if (isSpaceAt(doc, chipPos - 1) && chipAt(doc, chipPos - 2) === null) {
    from = chipPos - 1;
  }
  // Right space at [chipPos+1, chipPos+2]: exclusive unless a chip sits after it.
  if (isSpaceAt(doc, chipPos + 1) && chipAt(doc, chipPos + 2) === null) {
    to = chipPos + 2;
  }
  // Double-shared: absorb the right shared space so the neighbours heal to ONE.
  if (leftShared && rightShared) to = chipPos + 2;
  return { from, to };
}

/**
 * The chip a BACKWARD (Backspace) delete at `pos` targets — the chip lying in the
 * delete DIRECTION (leftward): the chip directly before the cursor, or the LEFT
 * chip owning the space directly before the cursor. For a space shared by two
 * chips the LEFT chip is targeted; its exclusive spaces go, the shared one stays
 * for the right chip. There is NO reverse-direction case (a chip to the RIGHT is
 * never deleted by Backspace) — under the D model the cursor never rests on the
 * chip side of an owned space, so `text␣|▢` is unreachable and, if reached, is
 * left to native (which just removes the space, re-added by the invariant).
 * @param doc - The document node.
 * @param pos - The collapsed cursor position.
 * @returns The target chip's start position, or null (native delete).
 */
function targetChipBackward(doc: PMNode, pos: number): number | null {
  if (chipAt(doc, pos - 1) !== null) return pos - 1;
  if (isSpaceAt(doc, pos - 1) && chipAt(doc, pos - 2) !== null) {
    return pos - 2; // space is that chip's RIGHT owned space
  }
  return null;
}

/**
 * The chip a FORWARD (Delete) delete at `pos` targets — the chip lying in the
 * delete DIRECTION (rightward): the chip directly after the cursor, or the RIGHT
 * chip owning the space directly after the cursor. For a shared space the RIGHT
 * chip is targeted; its exclusive spaces go, the shared one stays for the left
 * chip. Mirror of {@link targetChipBackward}: there is NO reverse-direction case
 * (a chip to the LEFT is never deleted by Delete) — the `▢|␣text` position is
 * unstoppable under the D model and, if reached, is left to native.
 * @param doc - The document node.
 * @param pos - The collapsed cursor position.
 * @returns The target chip's start position, or null (native delete).
 */
function targetChipForward(doc: PMNode, pos: number): number | null {
  if (chipAt(doc, pos) !== null) return pos;
  if (isSpaceAt(doc, pos) && chipAt(doc, pos + 1) !== null) {
    return pos + 1; // space is that chip's LEFT owned space
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
 * survivor keeps its anchor). Ranges are descending and merged, so a caller can
 * `tr.delete` each in order without shifting the rest.
 *
 * RUN-AWARE HEAL (design 2026-07-13; R3): a deleted run — one stale chip OR a run
 * of adjacent stale chips — flanked on BOTH sides by a SURVIVING chip's shared
 * space would leave the two survivors with a DOUBLE space that the additive
 * {@link planWhitespaceInsertions} can never repair (and which leaks into the
 * backend prompt). So, after merging, any range whose two flanking spaces are
 * BOTH shared with a surviving chip absorbs its RIGHT flank; the LEFT flank stays
 * as the survivors' single shared space. This subsumes the lone-double-shared
 * chip AND a run of ≥2 adjacent stale chips flanked by survivors.
 * @param doc - The document node.
 * @param stalePositions - Start positions of the chips being cascaded away.
 * @returns The merged, heal-adjusted `[from, to)` ranges to delete, descending.
 */
export function planCascadeDeletion(
  doc: PMNode,
  stalePositions: ReadonlySet<number>,
): DocRange[] {
  const ranges: DocRange[] = [];
  for (const p of stalePositions) {
    let from = p;
    let to = p + 1;
    const leftSurvivingShared =
      isSpaceAt(doc, p - 1) &&
      chipAt(doc, p - 2) !== null &&
      !stalePositions.has(p - 2);
    const rightSurvivingShared =
      isSpaceAt(doc, p + 1) &&
      chipAt(doc, p + 2) !== null &&
      !stalePositions.has(p + 2);
    // A flanking space is removed with the chip UNLESS it is shared with a
    // SURVIVING chip (then it stays as that survivor's anchor).
    if (isSpaceAt(doc, p - 1) && !leftSurvivingShared) from = p - 1;
    if (isSpaceAt(doc, p + 1) && !rightSurvivingShared) to = p + 2;
    ranges.push({ from, to });
  }
  // Descending sort + merge overlapping / adjacent ranges (immutably).
  const merged: DocRange[] = [];
  for (const r of [...ranges].sort((a, b) => b.from - a.from)) {
    const last = merged[merged.length - 1];
    if (last !== undefined && r.to >= last.from) {
      merged[merged.length - 1] = {
        from: Math.min(last.from, r.from),
        to: Math.max(last.to, r.to),
      };
    } else {
      merged.push({ ...r });
    }
  }
  // Run-aware heal: a merged deletion flanked on BOTH sides by a surviving chip's
  // shared space absorbs its right flank so the survivors heal to ONE shared space.
  return merged.map((r) => {
    const leftFlankSurvivingShared =
      isSpaceAt(doc, r.from - 1) &&
      chipAt(doc, r.from - 2) !== null &&
      !stalePositions.has(r.from - 2);
    const rightFlankSurvivingShared =
      isSpaceAt(doc, r.to) &&
      chipAt(doc, r.to + 1) !== null &&
      !stalePositions.has(r.to + 1);
    return leftFlankSurvivingShared && rightFlankSurvivingShared
      ? { from: r.from, to: r.to + 1 }
      : r;
  });
}

/**
 * Plans the source-gap heal after a chip is MOVED by drag-and-drop (D1, user
 * 2026-07-14): ProseMirror's drop-move deletes only the dragged range, leaving
 * the chip's stranded anchor spaces behind — a double space mid-text, or a
 * stray leading / trailing space at a paragraph edge, that would reach the
 * backend prompt. Scans `uiEvent: 'drop'` transactions for deletion steps that
 * removed a chip, maps each gap into the CURRENT doc, and returns the space
 * deletion that heals it.
 *
 * A gap-side space counts as residue only when the departed range's EDGE CELL
 * on that side was a CHIP — only then is the space beyond the gap that chip's
 * stranded anchor (adversarial R2: an edge-char space test conflated "edge is
 * not a space" with "anchor stranded"; a range edged by TEXT, e.g. dragging
 * `bb ▢` out of `aa␣␣bb␣▢␣cc`, strands NO left anchor, and the space at the
 * gap's left is the user's own word gap which must never be touched). Each
 * residue candidate then passes two gates before deletion: it must not be an
 * adjacent chip's anchor, and deleting it must not weld two words together
 * (then it IS the word gap and stays).
 *
 * One-shot semantics: ProseMirror hands each later appendTransaction round
 * only the trs added since this plugin's previous call (trs.slice(n)), so the
 * drop transaction is visible EXACTLY ONCE — the returned range must heal the
 * gap completely in this single pass; there is no second chance.
 * @param transactions - The transactions that produced the current state.
 * @param doc - The CURRENT document.
 * @returns A deletion range (1 or 2 spaces), or null when nothing needs healing.
 */
export function planDropResidueHeal(
  transactions: readonly Transaction[],
  doc: PMNode,
): DocRange | null {
  for (let t = 0; t < transactions.length; t += 1) {
    const tr = transactions[t];
    if (tr.getMeta('uiEvent') !== 'drop') continue;
    for (let i = 0; i < tr.steps.length; i += 1) {
      const step = tr.steps[i];
      if (!(step instanceof ReplaceStep)) continue;
      // Pure deletions only (the drop's move-delete half).
      if (step.from === step.to || step.slice.size !== 0) continue;
      const before = tr.docs[i];
      let removedChip = false;
      before.nodesBetween(step.from, step.to, (node) => {
        if (isChip(node)) removedChip = true;
      });
      let gap = tr.mapping.slice(i + 1).map(step.from);
      for (let j = t + 1; j < transactions.length; j += 1) {
        gap = transactions[j].mapping.map(gap);
      }
      if (!removedChip) {
        // TEXT dragged out from between two chips (user 2026-07-14): the two
        // chips' anchors meet as a space pair (`[A]``[B]`) — under the D
        // model adjacent chips SHARE one space, so the pair collapses. Only
        // this exact shape (both outer neighbours are chips) is touched; a
        // user-typed double space elsewhere at the gap is left alone.
        if (
          isSpaceAt(doc, gap - 1) &&
          isSpaceAt(doc, gap) &&
          chipAt(doc, gap - 2) !== null &&
          chipAt(doc, gap + 1) !== null
        ) {
          return { from: gap, to: gap + 1 };
        }
        continue;
      }
      // A side's anchor is stranded at the gap only when the range's edge
      // cell on that side was the chip itself.
      const leftStranded = chipAt(before, step.from) !== null;
      const rightStranded = chipAt(before, step.to - 1) !== null;
      const heal = residueDeletionAt(doc, gap, leftStranded, rightStranded);
      if (heal !== null) return heal;
    }
  }
  return null;
}

/** What occupies the position next to a candidate space. */
type Neighbour = 'chip' | 'space' | 'text' | 'edge';

/**
 * Classifies the document cell at `pos` inside `$ref`'s textblock.
 * @param doc - The document.
 * @param pos - The candidate cell start.
 * @param parentStart - The textblock's content start position.
 * @param parentEnd - The textblock's content end position.
 * @returns The neighbour kind.
 */
function neighbourAt(
  doc: PMNode,
  pos: number,
  parentStart: number,
  parentEnd: number,
): Neighbour {
  if (pos < parentStart || pos >= parentEnd) return 'edge';
  if (chipAt(doc, pos) !== null) return 'chip';
  if (isSpaceAt(doc, pos)) return 'space';
  return 'text';
}

/**
 * The space deletion healing the residue at a chip-departure gap, or null.
 * Residue candidates = the gap-side spaces stranded by a chip at the departed
 * range's edge. Each candidate is kept when an adjacent chip still needs it as
 * its anchor, or when deleting it would weld text to text (it doubles as the
 * word gap). A candidate pair keeps at most one survivor under the same rules.
 * @param doc - The current document.
 * @param gap - The departure position in current coordinates.
 * @param leftStranded - Whether the range's FIRST cell was a chip (its left
 * anchor is stranded at the gap's left).
 * @param rightStranded - Whether the range's LAST cell was a chip (its right
 * anchor is stranded at the gap's right).
 * @returns The deletion range, or null.
 */
function residueDeletionAt(
  doc: PMNode,
  gap: number,
  leftStranded: boolean,
  rightStranded: boolean,
): DocRange | null {
  if (gap < 0 || gap > doc.content.size) return null;
  const $gap = doc.resolve(gap);
  if (!$gap.parent.isTextblock) return null;
  const parentStart = $gap.start();
  const parentEnd = $gap.start() + $gap.parent.content.size;
  const leftCand = leftStranded && isSpaceAt(doc, gap - 1);
  const rightCand = rightStranded && isSpaceAt(doc, gap);
  /**
   * Whether the single candidate space at `pos` must STAY: an adjacent chip
   * still needs it as its anchor, or its removal would weld text to text.
   * @param pos - The candidate space start.
   * @returns True when the space must be kept.
   */
  const mustKeep = (pos: number): boolean => {
    const before = neighbourAt(doc, pos - 1, parentStart, parentEnd);
    const after = neighbourAt(doc, pos + 1, parentStart, parentEnd);
    if (before === 'chip' || after === 'chip') return true;
    return before === 'text' && after === 'text';
  };
  if (leftCand && rightCand) {
    // Evaluate the pair right-first: with the right one gone, the left
    // candidate's effective right neighbour is whatever sits past it.
    const outerLeft = neighbourAt(doc, gap - 2, parentStart, parentEnd);
    const outerRight = neighbourAt(doc, gap + 1, parentStart, parentEnd);
    if (outerLeft === 'chip' || outerRight === 'chip') {
      // The survivor doubles as the adjacent chip's anchor — collapse to one.
      return { from: gap, to: gap + 1 };
    }
    const keepSurvivor = outerLeft === 'text' && outerRight === 'text';
    return keepSurvivor
      ? { from: gap, to: gap + 1 }
      : { from: gap - 1, to: gap + 1 };
  }
  if (rightCand && !mustKeep(gap)) return { from: gap, to: gap + 1 };
  if (leftCand && !mustKeep(gap - 1)) return { from: gap - 1, to: gap };
  return null;
}
