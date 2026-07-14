// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * ProseMirror plugin that keeps reference chips wrapped in real spaces, makes
 * deletion consistent, and enforces the D cursor model — the wiring around the
 * pure planners in reference-mention-whitespace.ts.
 *
 * Root cause (browser-engine layer): a reference chip is an inline uneditable
 * atom; a caret position next to it is a real document position but has no
 * adjacent DOM text node, so at a soft-wrap boundary the browser cannot use
 * caret affinity to disambiguate (snaps to the next line), IME has no compose
 * host, and the native pointer mis-hits the gap. The fix is one visible ordinary
 * space (U+0020 — a real text node) on every side of every chip, which restores
 * full text-caret semantics an img/ZWSP anchor cannot.
 *
 * Three mechanisms:
 * - appendTransaction runs {@link planWhitespaceInsertions} after every edit to
 *   ADD any missing chip spaces (only-adds, idempotent). Covers insert / paste /
 *   collab / @ / click-insert. Not history-excluded: the added space is a direct
 *   consequence of the user's chip insertion and undoes together with it.
 * - handleKeyDown Backspace/Delete uses {@link resolveDeletionUnit} so a chip +
 *   its exclusive owned spaces delete as one unit, in the delete direction only
 *   (no residue, no reverse-direction delete); a shared space stays for the
 *   neighbour.
 * - the D cursor model (an owned space is TRANSPARENT to the cursor — it may only
 *   rest on the side of an owned space away from its chip): handleKeyDown arrows
 *   cross a chip + its spaces in ONE press via {@link findNextStoppable};
 *   handleClick snaps a pointer landing to the nearest stoppable position; and
 *   appendTransaction {@link normalizeSelection} is the backstop for programmatic
 *   landings (@ insertion / collab / command) on an unstoppable position.
 *
 * The separator-era mouse-drag takeover (mousedown geometry resolver +
 * auto-scroll) was REMOVED (2026-07-14, after #322 shipped): it only fired at
 * "caret-blind" positions (a chip neighbour with NO adjacent text node), and the
 * whitespace invariant makes such positions unreachable — every chip side is a
 * real space text node between transactions, so the guard was provably always
 * false. Native drag-selection works on real text; the Chrome "can't drag past a
 * trailing atom" bug (#1152/#1199) required an atom at the line end, which the
 * trailing space now prevents. handleClick + arrow handling above are NOT part
 * of that takeover — they implement the D cursor model and stay.
 */

import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
} from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import {
  chipAt,
  chipDeletionUnit,
  findNextStoppable,
  isChip,
  isSpaceAt,
  isStoppable,
  nearestStoppable,
  planDropResidueHeal,
  planWhitespaceInsertions,
  resolveDeletionUnit,
} from '@web/spaces/canvas/generate/reference-mention-whitespace';

/** Identifies the caret/whitespace plugin (tests resolve the live plugin through it). */
export const referenceMentionCaretKey = new PluginKey('referenceMentionCaret');

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
  // The drop-residue heal (D1, user 2026-07-14) MUST ride the same appended
  // transaction: ProseMirror hands each later appendTransaction round only the
  // trs added SINCE the plugin's previous call (trs.slice(n)), so the
  // `uiEvent: 'drop'` transaction is only visible in the round that also adds
  // the landing-side spaces — a separate later pass would never see it.
  const heal = planDropResidueHeal(transactions, newState.doc);
  if (inserts.length === 0 && heal === null) return null;
  // Apply all edits highest-position-first so lower positions stay valid.
  const ops: { pos: number; run: (tr: Transaction) => void }[] = [
    ...inserts.map((pos) => ({
      pos,
      run: (tr: Transaction): void => {
        tr.insertText(' ', pos);
      },
    })),
  ];
  if (heal !== null) {
    ops.push({
      pos: heal.from,
      run: (tr: Transaction): void => {
        tr.delete(heal.from, heal.to);
      },
    });
  }
  ops.sort((a, b) => b.pos - a.pos);
  const tr = newState.tr;
  for (const op of ops) op.run(tr);
  return tr;
}

/**
 * The document position of the chip rendered by `chipEl`, or null. Resolved
 * through posAtDOM (pure DOM-tree walk, layout-free); the result is verified
 * against the doc since posAtDOM's convention for uneditable leaves differs by
 * a step depending on which wrapper element is passed.
 * @param view - The editor view.
 * @param chipEl - An element inside the chip's NodeView.
 * @returns The chip's start position, or null.
 */
function chipPosFromDom(view: EditorView, chipEl: Element): number | null {
  let raw: number;
  try {
    raw = view.posAtDOM(chipEl, 0);
  } catch {
    return null;
  }
  if (chipAt(view.state.doc, raw) !== null) return raw;
  if (chipAt(view.state.doc, raw - 1) !== null) return raw - 1;
  return null;
}

/**
 * Snaps an empty selection that landed on an UNSTOPPABLE position (D model) to
 * the nearest stoppable one — the backstop for programmatic landings the arrow /
 * click handlers don't cover: an @ insertion, a collab or command selection, or a
 * pointer resolve that fell on a chip-side of an owned space. Runs when the
 * selection or the doc changed. History-excluded (a pure caret correction, never
 * a user undo step). Converges: after the snap the selection is stoppable, so the
 * next pass finds nothing to move.
 * @param transactions - The transactions just applied.
 * @param newState - The resulting editor state.
 * @returns A transaction snapping the caret, or null.
 */
function normalizeSelection(
  transactions: readonly Transaction[],
  newState: EditorState,
): Transaction | null {
  if (!transactions.some((tr) => tr.selectionSet || tr.docChanged)) return null;
  const sel = newState.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return null;
  const snapped = nearestStoppable(newState.doc, sel.from);
  if (snapped === null || snapped === sel.from) return null;
  return newState.tr
    .setSelection(TextSelection.create(newState.doc, snapped))
    .setMeta('addToHistory', false);
}

/**
 * Creates the chip whitespace/caret plugin (installed by the ReferenceMention
 * extension): enforces the space-around-every-chip invariant, deletes a chip
 * plus its owned spaces as one unit, and implements the D cursor model
 * (one-press arrow crossing, click snapping, selection normalization).
 * @returns The ProseMirror plugin.
 */
export function createReferenceMentionCaret(): Plugin {
  // Multi-chip selection dragging (item ⑦, user 2026-07-14): on a REAL
  // mousedown over a select-none atom the browser clears the native selection
  // and PM follows, so by dragstart the chip-spanning selection has collapsed
  // and PM would drag a single chip. The plugin RECORDS the selection at
  // mousedown (record-only: preventDefault would make prosemirror-view's
  // runCustomHandler treat the event as handled — `handler(view, event) ||
  // event.defaultPrevented` — killing PM's own MouseDown tracking, i.e.
  // click-to-select went inert; adversarial R1 high) and RESTORES it at
  // dragstart, right before PM's own handler reads the selection to drag.
  // Plain clicks (no dragstart) are untouched; mouseup clears the record.
  let recordedDragSelection: { from: number; to: number } | null = null;
  return new Plugin({
    key: referenceMentionCaretKey,
    appendTransaction(transactions, _oldState, newState): Transaction | null {
      // Structure first (whitespace invariant + drop-residue heal, one
      // combined transaction — see appendWhitespace for why they must share a
      // round), then normalization on the settled positions.
      return (
        appendWhitespace(transactions, newState) ??
        normalizeSelection(transactions, newState)
      );
    },
    props: {
      handleDOMEvents: {
        // Record-only (see the plugin-closure comment): a press on a chip
        // inside a non-empty, non-node selection remembers the range for the
        // upcoming dragstart. Never preventDefault, never handle.
        mousedown: (view, event): boolean => {
          recordedDragSelection = null;
          if (event.button !== 0) return false;
          const target = event.target;
          if (!(target instanceof Element)) return false;
          const chipEl = target.closest('[data-reference-mention]');
          if (chipEl === null) return false;
          const sel = view.state.selection;
          if (sel.empty || sel instanceof NodeSelection) return false;
          const pos = chipPosFromDom(view, chipEl);
          if (pos === null || pos < sel.from || pos >= sel.to) return false;
          recordedDragSelection = { from: sel.from, to: sel.to };
          return false;
        },
        mouseup: (): boolean => {
          // A completed click never consumed the record — drop it.
          recordedDragSelection = null;
          return false;
        },
        dragstart: (view, event): boolean => {
          const record = recordedDragSelection;
          recordedDragSelection = null;
          if (record === null) return false;
          const target = event.target;
          if (!(target instanceof Element)) return false;
          const chipEl =
            target.closest('[data-reference-mention]') ??
            target.querySelector('[data-reference-mention]');
          if (chipEl === null) return false;
          const pos = chipPosFromDom(view, chipEl);
          if (pos === null || pos < record.from || pos >= record.to) {
            return false;
          }
          const { doc } = view.state;
          const from = Math.min(record.from, doc.content.size);
          const to = Math.min(record.to, doc.content.size);
          if (from >= to) return false;
          const sel = view.state.selection;
          if (sel.from !== from || sel.to !== to) {
            // The browser's native-clear collapsed the selection after the
            // press — restore it so PM's own dragstart handler (same native
            // listener chain, runs after this returns false) drags the WHOLE
            // recorded range. A pure selection restore, never an undo step.
            view.dispatch(
              view.state.tr
                .setSelection(TextSelection.create(doc, from, to))
                .setMeta('addToHistory', false),
            );
          }
          // Also cut the event off from React's root listener: tiptap's
          // NodeView.onDragStart would overwrite the selection with a
          // single-chip NodeSelection if it ever received the event.
          event.stopPropagation();
          return false;
        },
      },
      handleKeyDown: (view, event): boolean => {
        const sel = view.state.selection;
        // Node-selected chip (click-to-select) + Backspace/Delete: delete it as a
        // unit (chip + owned spaces), REGARDLESS of modifiers — a node selection has
        // no "delete word" meaning, and native deleteSelection would remove only the
        // chip node and orphan its spaces (deletion-path parity, design 2026-07-13
        // §5; R3: this must precede the modifier gate so Cmd/Ctrl+Delete on a
        // node-selected chip does not fall through to native).
        if (sel instanceof NodeSelection && isChip(sel.node)) {
          if (event.key === 'Backspace' || event.key === 'Delete') {
            const range = chipDeletionUnit(view.state.doc, sel.from);
            view.dispatch(
              view.state.tr.delete(range.from, range.to).scrollIntoView(),
            );
            return true;
          }
          return false; // arrows etc. on a node-selected chip stay native
        }
        if (
          event.shiftKey ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey
        ) {
          return false;
        }
        if (!(sel instanceof TextSelection) || !sel.empty) return false;
        const { doc } = view.state;
        const pos = sel.from;
        // Deletion unit (design 2026-07-13 §5): a chip + its exclusive owned
        // spaces delete together, in the DELETE DIRECTION only (D removed the
        // reverse-direction branches). A shared space stays for the neighbour.
        if (event.key === 'Backspace' || event.key === 'Delete') {
          const dir = event.key === 'Backspace' ? 'backward' : 'forward';
          const range = resolveDeletionUnit(doc, pos, dir);
          if (range === null) return false;
          view.dispatch(view.state.tr.delete(range.from, range.to).scrollIntoView());
          return true;
        }
        // Arrow crossing (D cursor model): an owned space is transparent to the
        // cursor, so a chip + its spaces is crossed in ONE press to the next
        // stoppable position. Take over ONLY when the arrow is about to enter a
        // chip region; plain-text moves stay native (grapheme clusters / RTL).
        if (event.key === 'ArrowRight') {
          const entersChip =
            chipAt(doc, pos) !== null ||
            (isSpaceAt(doc, pos) && chipAt(doc, pos + 1) !== null);
          if (!entersChip) return false;
          const target = findNextStoppable(doc, pos, 'forward');
          if (target === null) return false;
          view.dispatch(
            view.state.tr
              .setSelection(TextSelection.create(doc, target))
              .scrollIntoView(),
          );
          return true;
        }
        if (event.key === 'ArrowLeft') {
          const entersChip =
            chipAt(doc, pos - 1) !== null ||
            (isSpaceAt(doc, pos - 1) && chipAt(doc, pos - 2) !== null);
          if (!entersChip) return false;
          const target = findNextStoppable(doc, pos, 'backward');
          if (target === null) return false;
          view.dispatch(
            view.state.tr
              .setSelection(TextSelection.create(doc, target))
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
          return false; // click ON a chip → default node-selection handling
        }
        // A click resolving onto an UNSTOPPABLE position (a chip side of an owned
        // space) snaps to the nearest stoppable one right away, so the caret never
        // flashes on the transparent space. The appendTransaction normalization is
        // the backstop; this avoids the two-frame flicker.
        if (isStoppable(view.state.doc, pos)) return false;
        const snapped = nearestStoppable(view.state.doc, pos);
        if (snapped === null) return false;
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(view.state.doc, snapped),
          ),
        );
        return true;
      },
    },
  });
}
