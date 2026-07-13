// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * ProseMirror plugin that keeps reference chips wrapped in real spaces + makes
 * deletion consistent — the wiring around the pure planners in
 * reference-mention-whitespace.ts.
 *
 * Root cause (browser-engine layer): a reference chip is an inline uneditable
 * atom; a caret position next to it is a real document position but has no
 * adjacent DOM text node, so at a soft-wrap boundary the browser cannot use
 * caret affinity to disambiguate (snaps to the next line), IME has no compose
 * host, and the native pointer mis-hits the gap. The fix is one visible ordinary
 * space (U+0020 — a real text node) on every side of every chip, which restores
 * full text-caret semantics an img/ZWSP anchor cannot.
 *
 * Two orthogonal mechanisms:
 * - appendTransaction runs {@link planWhitespaceInsertions} after every edit to
 *   ADD any missing chip spaces (only-adds, idempotent). Covers insert / paste /
 *   collab / @ / click-insert. Not history-excluded: the added space is a direct
 *   consequence of the user's chip insertion and undoes together with it.
 * - handleKeyDown Backspace/Delete uses {@link resolveDeletionUnit} so a chip +
 *   its exclusive owned spaces delete as one unit (no residue, no "un-deletable"
 *   space); a space shared with an adjacent chip stays for the neighbour.
 *
 * KEPT PENDING REAL-MACHINE VERIFICATION (design 2026-07-13 §7): the mouse
 * takeover (handleClick + mousedown geometry + auto-scroll) and one-press chip
 * crossing were written for the old caret-blind gaps. With real spaces flanking
 * every chip those gaps no longer exist, so the native pointer/caret should just
 * work — but per the "separator removal regressed every gap click" lesson these
 * are NOT pre-deleted; a Chrome + Safari pass decides their removal. The
 * separator-img anchoring they replaced IS removed here.
 */

import type { ResolvedPos } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { REFERENCE_MENTION_NODE } from '@web/spaces/canvas/generate/at-reference';
import {
  isChip,
  planWhitespaceInsertions,
  resolveDeletionUnit,
} from '@web/spaces/canvas/generate/reference-mention-whitespace';

/** Identifies the caret/whitespace plugin (tests resolve the live plugin through it). */
export const referenceMentionCaretKey = new PluginKey('referenceMentionCaret');

/**
 * Whether a resolved position is "caret-blind": an inline position with NO
 * adjacent text node and at least one adjacent reference chip. With the
 * whitespace invariant active a chip is always flanked by spaces, so this is
 * normally false — the pointer takeover below is retained pending real-machine
 * verification (§7), not because caret-blind gaps are expected.
 * @param $pos - The resolved position.
 * @returns True at a caret-blind chip boundary.
 */
function isCaretBlind($pos: ResolvedPos): boolean {
  if (!$pos.parent.inlineContent) return false;
  const before = $pos.nodeBefore;
  const after = $pos.nodeAfter;
  if (before?.isText === true || after?.isText === true) return false;
  return isChip(before) || isChip(after);
}

/**
 * Resolves the doc position of a caret-blind chip gap under a pointer, robust to
 * browsers whose native hit-test mis-resolves a click in a chip gap to the
 * paragraph START (Safari). Fast path: `posAtCoords` when it already lands on a
 * caret-blind position (Chrome). Fallback: pick the gap by GEOMETRY — the chip
 * rects on the clicked line — so it never trusts the broken native position. The
 * result is verified caret-blind, so a click on ordinary text returns null and
 * native handling stays. Pure read of the view; used by the mousedown takeover.
 * @param view - The editor view.
 * @param clientX - Pointer X in viewport px.
 * @param clientY - Pointer Y in viewport px.
 * @returns The caret-blind doc position under the pointer, or null.
 */
function caretBlindPosFromClick(
  view: EditorView,
  clientX: number,
  clientY: number,
): number | null {
  const at = view.posAtCoords({ left: clientX, top: clientY });
  if (at && isCaretBlind(view.state.doc.resolve(at.pos))) return at.pos;
  const line: Array<{ before: number; after: number; rect: DOMRect }> = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== REFERENCE_MENTION_NODE) return;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return;
    const rect = dom.getBoundingClientRect();
    if (clientY >= rect.top && clientY <= rect.bottom) {
      line.push({ before: pos, after: pos + node.nodeSize, rect });
    }
  });
  if (line.length === 0) return null;
  line.sort((a, b) => a.rect.left - b.rect.left);
  let pos: number | null = null;
  if (clientX <= line[0].rect.left) pos = line[0].before;
  else if (clientX >= line[line.length - 1].rect.right) {
    pos = line[line.length - 1].after;
  } else {
    for (let i = 0; i < line.length - 1; i += 1) {
      if (clientX >= line[i].rect.right && clientX <= line[i + 1].rect.left) {
        pos = line[i].after;
        break;
      }
    }
  }
  return pos !== null && isCaretBlind(view.state.doc.resolve(pos)) ? pos : null;
}

/**
 * The nearest vertically-scrollable element at or above a node (the prompt's
 * scroll viewport), or null when nothing scrolls. Used by the mouse-drag takeover
 * to auto-scroll while selecting past an edge. Starts at `node` itself, since the
 * editor DOM (`.ProseMirror`) can be the scroll container.
 * @param node - The starting element.
 * @returns The scroll container, or null.
 */
function findScrollParent(node: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = node;
  while (el !== null) {
    const overflowY = getComputedStyle(el).overflowY;
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      el.scrollHeight > el.clientHeight
    ) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * Appends a transaction that adds any missing chip-flanking spaces, enforcing
 * the whitespace invariant after every doc-changing edit. Only-adds + idempotent
 * (positions come from {@link planWhitespaceInsertions}, descending so inserts
 * never invalidate lower positions; an already-satisfied doc yields none, so no
 * infinite append loop). Left un-history-excluded so the added space undoes with
 * the edit that introduced the chip.
 * @param transactions - The transactions just applied.
 * @param newState - The resulting editor state.
 * @returns A transaction adding the missing spaces, or null.
 */
function appendWhitespace(
  transactions: readonly Transaction[],
  newState: EditorState,
): Transaction | null {
  if (!transactions.some((tr) => tr.docChanged)) return null;
  const inserts = planWhitespaceInsertions(newState.doc);
  if (inserts.length === 0) return null;
  const tr = newState.tr;
  for (const pos of inserts) tr.insertText(' ', pos);
  return tr;
}

/**
 * Creates the chip whitespace/caret plugin (installed by the ReferenceMention
 * extension): enforces the space-around-every-chip invariant, deletes a chip
 * plus its owned spaces as one unit, and retains the (pending-verification)
 * one-press chip crossing + mouse takeover.
 * @returns The ProseMirror plugin.
 */
export function createReferenceMentionCaret(): Plugin {
  return new Plugin({
    key: referenceMentionCaretKey,
    appendTransaction(transactions, _oldState, newState): Transaction | null {
      return appendWhitespace(transactions, newState);
    },
    props: {
      handleKeyDown: (view, event): boolean => {
        if (
          event.shiftKey ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey
        ) {
          return false;
        }
        const sel = view.state.selection;
        if (!(sel instanceof TextSelection) || !sel.empty) return false;
        // Deletion unit (design 2026-07-13 §5): a chip + its exclusive owned
        // spaces delete together, so a chip leaves no residue and its space is
        // never re-added by the invariant ("un-deletable"). A shared space stays.
        if (event.key === 'Backspace' || event.key === 'Delete') {
          const dir = event.key === 'Backspace' ? 'backward' : 'forward';
          const range = resolveDeletionUnit(view.state.doc, sel.from, dir);
          if (range === null) return false;
          view.dispatch(
            view.state.tr.delete(range.from, range.to).scrollIntoView(),
          );
          return true;
        }
        // One-press chip crossing (P5): a chip is an atom, so a plain arrow lands
        // a NodeSelection ON it first and only a SECOND press steps the text
        // cursor past. Move the TEXT cursor straight to the far boundary in one
        // press. Kept pending real-machine verification (§7).
        const $pos = sel.$from;
        if (event.key === 'ArrowRight') {
          const after = $pos.nodeAfter;
          if (!isChip(after)) return false;
          view.dispatch(
            view.state.tr
              .setSelection(
                TextSelection.create(view.state.doc, $pos.pos + after.nodeSize),
              )
              .scrollIntoView(),
          );
          return true;
        }
        if (event.key === 'ArrowLeft') {
          const before = $pos.nodeBefore;
          if (!isChip(before)) return false;
          view.dispatch(
            view.state.tr
              .setSelection(
                TextSelection.create(view.state.doc, $pos.pos - before.nodeSize),
              )
              .scrollIntoView(),
          );
          return true;
        }
        return false;
      },
      handleClick: (view, pos, event): boolean => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest('[data-reference-mention]') !== null
        ) {
          return false;
        }
        const $pos = view.state.doc.resolve(pos);
        if (!$pos.parent.inlineContent) return false;
        const before = $pos.nodeBefore;
        const after = $pos.nodeAfter;
        if (before?.isText === true || after?.isText === true) return false;
        if (!isChip(before) && !isChip(after)) return false;
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(view.state.doc, pos),
          ),
        );
        return true;
      },
      handleDOMEvents: {
        // Mouse-selection takeover for CARET-BLIND chip gaps. ProseMirror has no
        // mouse-selection code of its own; browsers mishandle uneditable inline
        // atoms (Chrome refuses to extend a native drag past a trailing atom;
        // Safari drops a click between two chips). Scoped tightly by
        // caretBlindPosFromClick, which returns a position ONLY at a verified
        // caret-blind gap. Kept pending real-machine verification (§7); with the
        // whitespace invariant active it should rarely fire. Selection-only
        // transactions never enter the y-prosemirror undo stack.
        mousedown: (view, event: MouseEvent): boolean => {
          if (
            event.button !== 0 ||
            event.shiftKey ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey
          ) {
            return false;
          }
          const target = event.target;
          if (
            target instanceof Element &&
            target.closest('[data-reference-mention]') !== null
          ) {
            return false;
          }
          const anchor = caretBlindPosFromClick(
            view,
            event.clientX,
            event.clientY,
          );
          if (anchor === null) return false;
          event.preventDefault();
          view.focus();
          view.dispatch(
            view.state.tr.setSelection(
              TextSelection.create(view.state.doc, anchor),
            ),
          );
          const scroller = findScrollParent(view.dom);
          let scrollRaf = 0;
          let lastX = event.clientX;
          let lastY = event.clientY;
          /**
           * Extends the takeover selection to a viewport point.
           * @param clientX - Pointer X in viewport px.
           * @param clientY - Pointer Y in viewport px.
           */
          const extendTo = (clientX: number, clientY: number): void => {
            const head = view.posAtCoords({ left: clientX, top: clientY });
            if (!head) return;
            view.dispatch(
              view.state.tr.setSelection(
                TextSelection.create(view.state.doc, anchor, head.pos),
              ),
            );
          };
          /**
           * One auto-scroll frame: while the pointer sits in the top/bottom edge
           * band, scroll the viewport and re-extend the selection to a point
           * clamped inside the viewport; reschedules until the pointer leaves the
           * band or the drag ends.
           */
          const scrollTick = (): void => {
            scrollRaf = 0;
            if (scroller === null) return;
            const rect = scroller.getBoundingClientRect();
            const EDGE_PX = 24;
            const STEP_PX = 10;
            let dy = 0;
            if (lastY < rect.top + EDGE_PX) dy = -STEP_PX;
            else if (lastY > rect.bottom - EDGE_PX) dy = STEP_PX;
            if (dy === 0) return;
            scroller.scrollTop += dy;
            extendTo(
              lastX,
              Math.max(rect.top + 2, Math.min(rect.bottom - 2, lastY)),
            );
            scrollRaf = requestAnimationFrame(scrollTick);
          };
          /**
           * Extends the takeover selection and (re)starts edge auto-scroll.
           * @param move - The mousemove event.
           */
          const onMove = (move: MouseEvent): void => {
            lastX = move.clientX;
            lastY = move.clientY;
            extendTo(move.clientX, move.clientY);
            if (scrollRaf === 0) scrollRaf = requestAnimationFrame(scrollTick);
          };
          /** Tears down the takeover's listeners + auto-scroll on mouse release. */
          const onUp = (): void => {
            if (scrollRaf !== 0) cancelAnimationFrame(scrollRaf);
            scrollRaf = 0;
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
          };
          document.addEventListener('mousemove', onMove, true);
          document.addEventListener('mouseup', onUp, true);
          return true;
        },
      },
    },
  });
}
