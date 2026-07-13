// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Native-caret anchor for the caret-blind positions around reference chips.
 *
 * Root cause (WebKit bug 15256 / TipTap #2978): a text caret at a gap between
 * two adjacent inline atoms — or before a leading atom at paragraph start — is a
 * real document position (typing lands there) but the DOM has no text node to
 * anchor a native caret to. Chrome holds the model selection but paints nothing;
 * WebKit canonicalises the endpoint to the nearest editable text and snaps the
 * caret AND typed input to paragraph start.
 *
 * PM's own fix at a textblock END is `img.ProseMirror-separator`
 * (addTextblockHacks) — a raw, view-only, model-invisible replaced element the
 * browser CAN anchor a native caret next to. PM injects it only at the trailing
 * position; this plugin extends the SAME first-party technique to the gaps PM
 * leaves uncovered (between two chips, before a leading chip) by emitting a raw
 * separator img widget decoration at each. The widget's `raw: true` skips
 * PM's contentEditable=false wrapping (which would re-create the unanchorable
 * island), and its parseRule `{ignore: true}` keeps it out of the model — zero
 * Yjs sync, zero offset drift. This replaced the earlier display-only fake caret,
 * which never participated in the native selection so it could not fix WebKit's
 * wrong insertion point (A, user 2026-07-12). All imports come from `@tiptap/pm`
 * so the plugin shares TipTap's single prosemirror instance.
 *
 * NOTE (verified 2026-07-12, real Chrome + Safari): the separator anchors + holds
 * a native caret mid-line and accepts typing. But it does NOT make the native
 * POINTER work — a click in a gap resolves to the adjacent chip (NodeSelection)
 * and a native drag cannot pass a trailing atom. So the mouse takeover
 * (handleClick + mousedown + geometry, below) is a PERMANENT pointer layer, not a
 * stopgap: deleting it regressed every gap click / drag. One-press chip crossing
 * is an independent keyboard UX.
 */

import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';

import { REFERENCE_MENTION_NODE } from '@web/spaces/canvas/generate/at-reference';

/** Identifies the caret/anchor plugin (tests resolve the live plugin through it). */
export const referenceMentionCaretKey = new PluginKey('referenceMentionCaret');

/**
 * CSS class of PM's separator img — the native-caret anchor. index.css keeps it
 * 0x0: a non-zero WIDTH nudges the following chip AND re-breaks Chrome's native
 * drag hit-test (tiptap #4646); a non-zero HEIGHT gives no benefit — the gap
 * caret takes the adjacent chip's height, not this 0-width img's.
 */
export const REFERENCE_MENTION_SEPARATOR_CLASS = 'ProseMirror-separator';

/**
 * Whether a node is a reference-mention chip. A type guard: a true result also
 * narrows the node to non-null (the arrow-key handler steps past `node.nodeSize`).
 * @param node - The adjacent node (null at a paragraph edge).
 * @returns True for a reference-mention atom.
 */
function isChip(node: PMNode | null): node is PMNode {
  return node?.type.name === REFERENCE_MENTION_NODE;
}

/**
 * Whether a resolved position is "caret-blind": an inline position with NO
 * adjacent text node (nothing for the browser to anchor a native caret to) and
 * at least one adjacent reference chip.
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
 * Whether a resolved position is the TRAILING caret-blind position: the end of
 * the textblock (`nodeAfter === null`) right after a chip. PM's addTextblockHacks
 * injects an `img.ProseMirror-separator` here that anchors a NATIVE caret, so
 * (a) the fake caret is RETIRED at this spot — the native caret takes over — and
 * (b) it is the exact position Chrome refuses to native-drag FROM (B1, user
 * 2026-07-12). Between-chip and leading-chip caret-blind positions have no
 * separator, so the fake caret stays there.
 * @param $pos - The resolved position.
 * @returns True at the trailing after-chip position.
 */
export function isTrailingCaretBlind($pos: ResolvedPos): boolean {
  return (
    $pos.parent.inlineContent &&
    $pos.nodeAfter === null &&
    isChip($pos.nodeBefore)
  );
}

/**
 * Every caret-blind gap position in the document that needs a native-caret
 * anchor: each position flanking a reference chip that is caret-blind (no
 * adjacent text node) EXCEPT the trailing after-chip position, where PM's
 * addTextblockHacks already injects its own separator. STRUCTURAL, not
 * selection-gated — the anchors exist regardless of where the caret sits, so a
 * click or arrow into any gap lands the native caret there. Deduped (the
 * position between two adjacent chips flanks both) and ascending.
 * @param doc - The document node.
 * @returns The gap positions needing a separator anchor, ascending.
 */
export function caretBlindGaps(doc: PMNode): number[] {
  const gaps = new Set<number>();
  doc.descendants((node, pos) => {
    if (!isChip(node)) return;
    // A chip's caret-blind neighbours are the positions immediately before and
    // after it; keep the ones with no text anchor and no PM separator (trailing).
    for (const at of [pos, pos + node.nodeSize]) {
      const $at = doc.resolve(at);
      if (isCaretBlind($at) && !isTrailingCaretBlind($at)) gaps.add(at);
    }
  });
  return [...gaps].sort((a, b) => a - b);
}

/**
 * Resolves the doc position of a caret-blind chip gap under a pointer, robust to
 * browsers whose native hit-test mis-resolves a click in a chip gap to the
 * paragraph START (Safari, #1756). Fast path: `posAtCoords` when it already
 * lands on a caret-blind position (Chrome). Fallback: pick the gap by GEOMETRY —
 * the chip rects on the clicked line — so it never trusts the broken native
 * position. The result is verified caret-blind, so a click on ordinary text (or
 * a gap that is not caret-blind) returns null and native handling stays. Pure
 * read of the view; used by the mousedown takeover.
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
  // Geometry fallback: collect the chips on the clicked line, then place the
  // anchor in the gap the pointer falls in (before the first, after the last, or
  // between two adjacent chips).
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
 * Builds the native-caret anchor: a bare `img.ProseMirror-separator` (0px,
 * `alt=""` → silent to assistive tech, no `src` → an unresolved replaced element
 * the browser anchors a caret next to), the same element PM injects at a trailing
 * chip. Handed to a `raw` widget decoration so PM does not wrap it in a
 * contentEditable=false span (which would re-create the unanchorable island).
 * @returns The separator img.
 */
export function renderSeparator(): HTMLElement {
  const img = document.createElement('img');
  img.className = REFERENCE_MENTION_SEPARATOR_CLASS;
  img.setAttribute('alt', '');
  img.setAttribute('aria-hidden', 'true');
  return img;
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
 * Creates the chip-boundary caret/anchor plugin (installed by the
 * ReferenceMention extension): injects a raw `img.ProseMirror-separator` at
 * every caret-blind chip gap so the browser anchors a NATIVE caret there, and
 * turns a click landing in the gap between chips into a text cursor there. Clicks
 * ON a chip keep the default NodeSelection behavior (the chip selects as a unit).
 * The separator anchors are structural (no focus gate is needed: a native caret
 * only renders in a focused editor, and the 0-width anchor is invisible otherwise).
 * @returns The ProseMirror plugin.
 */
export function createReferenceMentionCaret(): Plugin {
  return new Plugin({
    key: referenceMentionCaretKey,
    props: {
      // One-press chip crossing (P5, user 2026-07-12): a reference chip is an
      // atom, so a plain ArrowRight from before it lands a NodeSelection ON the
      // chip (highlighted, no caret) and only a SECOND press steps the text
      // cursor past it. When the caret's immediate neighbour in the arrow
      // direction is a chip, move the TEXT cursor straight to the far boundary,
      // skipping the atom stop — one press shows the caret past the chip. The
      // chip stays deletable (Backspace at the boundary) and click-selectable.
      // Shift / modifier chords fall through to native behavior (selection
      // extension, word jumps), and non-chip neighbours keep native arrows.
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
                TextSelection.create(
                  view.state.doc,
                  $pos.pos - before.nodeSize,
                ),
              )
              .scrollIntoView(),
          );
          return true;
        }
        return false;
      },
      handleClick: (view, pos, event): boolean => {
        // A click on the chip itself must keep selecting the chip as a unit.
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
        // With a text anchor the default click handling places a fine caret.
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
        // Mouse-selection takeover for CARET-BLIND chip gaps (B1 + Safari
        // #1756, user 2026-07-12). ProseMirror has no mouse-selection code of
        // its own — it delegates click placement + drag-select to the browser —
        // and browsers mishandle uneditable inline atoms: Chrome refuses to
        // extend a native drag past a trailing atom (dragging left from after a
        // trailing chip selected nothing, #1152/#1199), and Safari drops a click
        // BETWEEN two chips at the paragraph start. PM hand-wrote the KEYBOARD
        // takeover for crossing these atoms (selectHorizontally, #937; mirrored
        // in handleKeyDown above); this is the mouse sibling it never wrote — we
        // place the caret + compute the TextSelection ourselves. Scoped tightly
        // by caretBlindPosFromClick, which returns a position ONLY at a
        // verified caret-blind gap (and via GEOMETRY, not the browser's broken
        // hit-test, so Safari lands the right spot). A press on plain text or ON
        // a chip returns false → native handling + chip node-selection untouched.
        // Selection-only transactions never enter the y-prosemirror undo stack.
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
          // A press ON a chip keeps the default NodeSelection (mirror handleClick).
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
          // Auto-scroll the prompt viewport while dragging near/past an edge (B,
          // user 2026-07-13). PM's own drag-select does this; the takeover
          // replaced native drag at caret-blind gaps and did not, so dragging up
          // from a gap could not scroll up — a caret past the visible top makes
          // posAtCoords return null → the selection neither extended nor scrolled.
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
           * clamped inside the viewport (so posAtCoords resolves); reschedules
           * itself until the pointer leaves the band or the drag ends.
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
      decorations(state): DecorationSet | null {
        const gaps = caretBlindGaps(state.doc);
        if (gaps.length === 0) return null;
        // `raw: true` skips PM's contentEditable=false widget wrapping (which
        // would re-create the unanchorable island); `side: -1` places the anchor
        // on the caret's left; the per-position key keeps the DecorationSet
        // stable across transactions.
        return DecorationSet.create(
          state.doc,
          gaps.map((pos) =>
            Decoration.widget(pos, renderSeparator, {
              raw: true,
              side: -1,
              key: `refsep@${pos}`,
            }),
          ),
        );
      },
    },
  });
}
