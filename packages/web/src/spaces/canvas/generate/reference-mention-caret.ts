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
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
} from '@tiptap/y-tiptap';
import { compareRelativePositions } from 'yjs';
import type { Doc as YDoc, RelativePosition, XmlFragment } from 'yjs';

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

/**
 * A recorded selection range as Yjs RELATIVE positions. Absolute positions
 * cannot survive the real collab pipeline: y-prosemirror delivers EVERY
 * Yjs-origin change (a remote wire edit, a yUndo undo/redo) as one full-doc
 * ReplaceStep, whose StepMap collapses all interior positions (adversarial
 * R3, probe-proven on the real two-doc wire path — a co-editor edit in a
 * DIFFERENT paragraph destroyed the record). Relative positions are
 * y-prosemirror's own tool for surviving that (its selection restore uses
 * them) and need no per-transaction mapping at all.
 */
interface DragRecord {
  /** Recorded selection start (Yjs relative position). */
  from: RelativePosition;
  /** Recorded selection end (Yjs relative position). */
  to: RelativePosition;
}

/** The y-sync plugin state internals needed for position conversion. */
interface YSyncState {
  /** The bound Y.XmlFragment. */
  type: XmlFragment;
  /** The live binding (null until the view attaches). */
  binding: { mapping: unknown } | null;
  /** The Y.Doc. */
  doc: YDoc;
}

/**
 * The y-sync plugin state, located by KEY NAME (same duplicate-copy-safe
 * pattern as collab-undo-selection.ts — an imported ySyncPluginKey instance
 * would silently miss if the bundle ever carried a second y-tiptap copy).
 * @param state - The editor state.
 * @returns The y-sync state, or null when Collaboration is absent.
 */
function ySyncStateOf(state: EditorState): YSyncState | null {
  const plugin = state.plugins.find(
    (pl) => (pl as unknown as { key?: string }).key === 'y-sync$',
  );
  return (plugin?.getState(state) as YSyncState | undefined) ?? null;
}

/**
 * Converts an absolute selection range into a relative-position record.
 * @param state - The editor state.
 * @param from - Absolute range start.
 * @param to - Absolute range end.
 * @returns The record, or null when the y-sync binding is not ready.
 */
function recordFromRange(
  state: EditorState,
  from: number,
  to: number,
): DragRecord | null {
  const y = ySyncStateOf(state);
  if (y === null || y.binding === null) return null;
  return {
    from: absolutePositionToRelativePosition(
      from,
      y.type,
      y.binding.mapping as never,
    ),
    to: absolutePositionToRelativePosition(
      to,
      y.type,
      y.binding.mapping as never,
    ),
  };
}

/**
 * Resolves a relative-position record back to absolute positions in the
 * CURRENT document.
 * @param state - The editor state.
 * @param record - The record to resolve.
 * @returns The absolute range, or null when either end no longer resolves.
 */
function recordToRange(
  state: EditorState,
  record: DragRecord,
): { from: number; to: number } | null {
  const y = ySyncStateOf(state);
  if (y === null || y.binding === null) return null;
  const from = relativePositionToAbsolutePosition(
    y.doc,
    y.type,
    record.from,
    y.binding.mapping as never,
  );
  const to = relativePositionToAbsolutePosition(
    y.doc,
    y.type,
    record.to,
    y.binding.mapping as never,
  );
  if (from === null || to === null) return null;
  return { from, to };
}

/** The plugin's drag-tracking state (relative positions — no mapping needed). */
interface DragPluginState {
  /** mousedown -> dragstart: the chip-spanning selection to restore (item 7). */
  record: DragRecord | null;
  /**
   * dragstart -> drop: the drag's SOURCE selection. Safari moves the live
   * document selection to the drop caret while hovering, so PM's move-delete
   * (deleteSelection) becomes a no-op and the drag turns into a COPY (#1776,
   * user real-Safari trace: view.dragging present at drop, yet the source
   * stayed). handleDrop restores this range before PM's native drop runs.
   */
  source: DragRecord | null;
}

/** Identifies the caret/whitespace plugin (tests resolve the live plugin through it). */
export const referenceMentionCaretKey = new PluginKey<DragPluginState>(
  'referenceMentionCaret',
);

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
 * The element a pointer/drag event actually concerns: the target itself, or —
 * when the browser dispatches the event on a bare TEXT node (real Chrome does
 * this for dragstart when the press landed on a chip's label text) — its
 * parent element. A `target instanceof Element` guard alone silently skips the
 * whole handler in that case (adversarial: real-machine trace, 2026-07-14).
 * @param target - The raw event target.
 * @returns The target element, or null.
 */
function targetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
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
 * Gives a chip-bearing drag a mouse-following drag image on EVERY browser.
 * tiptap's NodeView.onDragStart only sets one when React receives the event —
 * true in Chrome (the Text-node target routes into React) but never in Safari,
 * so a chip drag showed no ghost there (user 2026-07-14). Cloning the dragged
 * range's rendered DOM keeps single- and multi-chip drags consistent across
 * browsers; plain-text drags keep the browser's native ghost. Best-effort: any
 * failure silently falls back to the native ghost (a visual enhancement, not a
 * business error).
 * @param view - The editor view.
 * @param event - The dragstart event.
 */
function setChipDragImage(view: EditorView, event: Event): void {
  const dt = (event as DragEvent).dataTransfer;
  if (!dt || typeof dt.setDragImage !== 'function') return;
  const sel = view.state.selection;
  if (sel.empty) return;
  let hasChip = false;
  view.state.doc.nodesBetween(sel.from, sel.to, (n) => {
    if (isChip(n)) hasChip = true;
  });
  if (!hasChip) return;
  try {
    const range = document.createRange();
    const fromDom = view.domAtPos(sel.from);
    const toDom = view.domAtPos(sel.to);
    range.setStart(fromDom.node, fromDom.offset);
    range.setEnd(toDom.node, toDom.offset);
    // Mirror the native selection-snapshot semantics (user 2026-07-14: the
    // Safari-style ghost is the standard): keep the dragged content's own
    // line layout (same width/font as the source, so soft-wraps reproduce)
    // and anchor the image at the press point's offset INSIDE the content —
    // never pin the pointer to the first character.
    const rect = range.getBoundingClientRect();
    const editorStyle = getComputedStyle(view.dom);
    const ghost = document.createElement('div');
    ghost.style.cssText =
      'position:absolute;top:-9999px;left:-9999px;pointer-events:none;';
    ghost.style.width = `${Math.ceil(rect.width)}px`;
    ghost.style.font = editorStyle.font;
    ghost.style.lineHeight = editorStyle.lineHeight;
    ghost.style.whiteSpace = 'pre-wrap';
    ghost.appendChild(range.cloneContents());
    document.body.appendChild(ghost);
    const pointer = event as DragEvent;
    const offsetX = Math.max(0, pointer.clientX - rect.left);
    const offsetY = Math.max(0, pointer.clientY - rect.top);
    dt.setDragImage(ghost, offsetX, offsetY);
    setTimeout(() => {
      ghost.remove();
    }, 0);
  } catch {
    // Native ghost stays — the enhancement must never break the drag.
  }
}

/**
 * Creates the chip whitespace/caret plugin (installed by the ReferenceMention
 * extension): enforces the space-around-every-chip invariant, deletes a chip
 * plus its owned spaces as one unit, and implements the D cursor model
 * (one-press arrow crossing, click snapping, selection normalization).
 * @returns The ProseMirror plugin.
 */
/**
 * Whether two records hold the same range (or are both null).
 * @param a - One record.
 * @param b - The other record.
 * @returns True when equal.
 */
function sameRecord(a: DragRecord | null, b: DragRecord | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    compareRelativePositions(a.from, b.from) &&
    compareRelativePositions(a.to, b.to)
  );
}

/**
 * Patches the drag-tracking plugin state (a pure-meta transaction: no doc
 * change, never an undo step). Skipped when the patch changes nothing, so
 * plain presses dispatch nothing.
 * @param view - The editor view.
 * @param patch - The slots to update (omitted slots keep their value).
 */
function patchDragState(
  view: EditorView,
  patch: Partial<DragPluginState>,
): void {
  const current = referenceMentionCaretKey.getState(view.state) ?? {
    record: null,
    source: null,
  };
  const next: DragPluginState = {
    record: patch.record !== undefined ? patch.record : current.record,
    source: patch.source !== undefined ? patch.source : current.source,
  };
  if (
    sameRecord(next.record, current.record) &&
    sameRecord(next.source, current.source)
  ) {
    return;
  }
  view.dispatch(view.state.tr.setMeta(referenceMentionCaretKey, next));
}

/**
 * The item-7 dragstart half: consumes the mousedown record and, when the
 * press-time chip-spanning selection has collapsed (the browser's native
 * clear), restores it so PM's own dragstart handler drags the WHOLE recorded
 * range; also stops propagation so tiptap's NodeView.onDragStart (React side)
 * cannot overwrite the selection with a single-chip NodeSelection. Handles
 * real Chrome's bare-TEXT-node dragstart target via {@link targetElement}.
 * @param view - The editor view.
 * @param event - The dragstart event.
 */
function restoreChipSpanSelection(view: EditorView, event: Event): void {
  const record = referenceMentionCaretKey.getState(view.state)?.record ?? null;
  if (record === null) return;
  patchDragState(view, { record: null });
  const target = targetElement(event.target);
  if (target === null) return;
  const chipEl =
    target.closest('[data-reference-mention]') ??
    target.querySelector('[data-reference-mention]');
  if (chipEl === null) return;
  const range = recordToRange(view.state, record);
  if (range === null) return;
  const pos = chipPosFromDom(view, chipEl);
  if (pos === null || pos < range.from || pos >= range.to) return;
  const { doc } = view.state;
  const from = Math.min(range.from, doc.content.size);
  const to = Math.min(range.to, doc.content.size);
  if (from >= to) return;
  const sel = view.state.selection;
  if (sel.from !== from || sel.to !== to) {
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(doc, from, to))
        .setMeta('addToHistory', false),
    );
  }
  event.stopPropagation();
}

/**
 * Creates the chip whitespace/caret plugin (installed by the ReferenceMention
 * extension): enforces the space-around-every-chip invariant + the drop-residue
 * heal, deletes a chip plus its owned spaces as one unit, implements the D
 * cursor model (one-press arrow crossing, click snapping, selection
 * normalization), and carries the drag-tracking state (mousedown record →
 * dragstart restore; dragstart source → drop restore, #1776) in its plugin
 * state, mapped through every transaction.
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
  // The record lives in PLUGIN STATE and is mapped through every transaction
  // (adversarial R2: a remote Yjs edit landing between mousedown and dragstart
  // drifted a raw closure record onto the WRONG content — collab critical path).
  return new Plugin<DragPluginState>({
    key: referenceMentionCaretKey,
    state: {
      init: (): DragPluginState => ({ record: null, source: null }),
      apply: (tr, value): DragPluginState => {
        // Relative positions track the Yjs document by identity — no
        // per-transaction mapping (which a full-doc y-sync ReplaceStep would
        // destroy anyway, adversarial R3).
        const meta = tr.getMeta(referenceMentionCaretKey) as
          | DragPluginState
          | undefined;
        return meta !== undefined ? meta : value;
      },
    },
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
          if (event.button !== 0) {
            patchDragState(view, { record: null });
            return false;
          }
          const target = targetElement(event.target);
          const chipEl = target?.closest('[data-reference-mention]') ?? null;
          const sel = view.state.selection;
          const pos = chipEl !== null ? chipPosFromDom(view, chipEl) : null;
          const qualifies =
            chipEl !== null &&
            !sel.empty &&
            !(sel instanceof NodeSelection) &&
            pos !== null &&
            pos >= sel.from &&
            pos < sel.to;
          patchDragState(view, {
            record: qualifies
              ? recordFromRange(view.state, sel.from, sel.to)
              : null,
          });
          return false;
        },
        mouseup: (view): boolean => {
          // A completed click never consumed the record — drop it.
          patchDragState(view, { record: null });
          return false;
        },
        dragstart: (view, event): boolean => {
          restoreChipSpanSelection(view, event);
          // Remember the drag's SOURCE selection for handleDrop (#1776):
          // Safari moves the live selection to the drop caret while hovering,
          // so PM's move-delete would otherwise delete nothing (drag -> copy).
          const sel = view.state.selection;
          patchDragState(view, {
            source: sel.empty
              ? null
              : recordFromRange(view.state, sel.from, sel.to),
          });
          setChipDragImage(view, event);
          return false;
        },
        dragend: (view): boolean => {
          // A drag that never dropped inside the editor (cancelled / dropped
          // outside) must not leave a stale source behind.
          patchDragState(view, { source: null });
          return false;
        },
      },
      /**
       * Restores the drag's source selection before ProseMirror's native drop
       * logic runs (#1776, real-Safari trace): with `view.dragging` present PM
       * treats the drop as a MOVE and deletes the CURRENT selection — but
       * Safari has already moved the live selection to the drop caret, so the
       * delete was a no-op and the drag pasted a copy. Restoring the recorded
       * source (mapped through any transactions since dragstart) makes PM's
       * own deleteSelection remove the dragged content. Never handles the
       * event (always returns false); a no-op on Chrome, whose selection does
       * not follow the drop caret.
       * @param view - The editor view.
       * @param _event - The drop event (unused).
       * @param _slice - The dropped slice (unused).
       * @param moved - Whether ProseMirror will treat the drop as a MOVE.
       * @returns Always false — ProseMirror's native drop logic continues.
       */
      handleDrop: (view, _event, _slice, moved): boolean => {
        const source =
          referenceMentionCaretKey.getState(view.state)?.source ?? null;
        if (source !== null) patchDragState(view, { source: null });
        if (!moved || source === null) return false;
        const range = recordToRange(view.state, source);
        if (range === null) return false;
        const { doc } = view.state;
        const from = Math.min(range.from, doc.content.size);
        const to = Math.min(range.to, doc.content.size);
        if (from >= to) return false;
        const sel = view.state.selection;
        if (sel.from !== from || sel.to !== to) {
          view.dispatch(
            view.state.tr
              .setSelection(TextSelection.create(doc, from, to))
              .setMeta('addToHistory', false),
          );
        }
        return false;
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
