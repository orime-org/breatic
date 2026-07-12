// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Fake caret for the caret-blind positions around reference chips.
 *
 * Root cause (TipTap #2978, batch-2 item 5): a text cursor between two
 * adjacent inline atoms is a real document position — typing lands there —
 * but the DOM selection has no text node to anchor to, so browsers do not
 * paint a native caret. Gapcursor is the wrong tool: its `valid()` rejects
 * any position whose parent is a textblock, so it never fires inside a
 * paragraph. The proven technique (prosemirror-codemark /
 * prosemirror-virtual-cursor, both MIT) is to draw the caret yourself as a
 * widget decoration; this plugin scopes that technique to exactly the
 * caret-blind chip boundaries, leaving the native caret in charge everywhere
 * else (zero IME surface — the moment a typed/composed character lands, a
 * text node exists and the plugin steps aside). All imports come from
 * `@tiptap/pm` so the plugin shares TipTap's single prosemirror instance.
 */

import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { REFERENCE_MENTION_NODE } from '@web/spaces/canvas/generate/at-reference';

/**
 * Identifies the caret plugin (tests resolve the live plugin through it).
 * Its plugin state is the focus flag mirrored from TipTap's focus/blur metas.
 */
export const referenceMentionCaretKey = new PluginKey<boolean>(
  'referenceMentionCaret',
);

/** CSS class of the fake-caret widget (drawn + blinked in index.css). */
export const REFERENCE_MENTION_CARET_CLASS = 'reference-mention-caret';

/**
 * Editor-root class while the fake caret shows — hides the native caret
 * (index.css) so the two never double-render at boundaries where a browser
 * happens to paint one.
 */
export const REFERENCE_MENTION_CARET_ACTIVE_CLASS =
  'reference-mention-caret-active';

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
 * Resolves the document position where the fake caret must render: a caret-blind
 * chip boundary EXCEPT the trailing after-chip position, where PM's separator
 * anchors a native caret (B1). Everywhere else — including an empty paragraph,
 * where ProseMirror's trailing break keeps the native caret visible — the native
 * caret is in charge and this returns null.
 * @param state - The editor state.
 * @returns The caret-blind position, or null when the native caret suffices.
 */
export function caretBlindPos(state: EditorState): number | null {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return null;
  const $pos = sel.$from;
  if (!isCaretBlind($pos)) return null;
  if (isTrailingCaretBlind($pos)) return null; // native caret via PM separator
  return $pos.pos;
}

/**
 * Builds the fake-caret DOM: a zero-width inline span whose left border is
 * the caret line (styled + blinked by `.reference-mention-caret` in
 * index.css). Purely visual — hidden from the accessibility tree.
 * @returns The caret element.
 */
function renderCaret(): HTMLElement {
  const el = document.createElement('span');
  el.className = REFERENCE_MENTION_CARET_CLASS;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/**
 * Creates the chip-boundary caret plugin (installed by the ReferenceMention
 * extension): draws a fake caret at caret-blind chip boundaries, hides the
 * native caret while doing so, and turns a click landing in the gap between
 * chips into a text cursor there. Clicks ON a chip keep the default
 * NodeSelection behavior (the chip selects as a unit).
 * @returns The ProseMirror plugin.
 */
export function createReferenceMentionCaret(): Plugin<boolean> {
  return new Plugin<boolean>({
    key: referenceMentionCaretKey,
    // Focus gate (adversarial round-1): a native caret never renders in an
    // unfocused editor, so neither may the fake one — without this it blinked
    // on panel open (initial selection lands before a leading chip while the
    // editor is unfocused) and kept blinking after blur, showing two carets
    // at once. TipTap's core focusEvents plugin dispatches `focus` / `blur`
    // transaction metas on the real DOM events; the plugin state mirrors
    // them (no duplicate DOM listeners).
    state: {
      init: (): boolean => false,
      apply: (tr, focused): boolean => {
        if (tr.getMeta('focus') !== undefined) return true;
        if (tr.getMeta('blur') !== undefined) return false;
        return focused;
      },
    },
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
        // Mouse-selection takeover for the TRAILING after-chip position (B1,
        // user 2026-07-12). ProseMirror has no mouse-selection code of its own —
        // it delegates drag-select to the browser — and Chrome refuses to extend
        // a native drag past an uneditable inline atom at the END of a line
        // (prosemirror #1152/#1199), so dragging left FROM after a trailing chip
        // selected nothing. PM hand-wrote the KEYBOARD takeover for crossing
        // these atoms (selectHorizontally, #937; mirrored in handleKeyDown
        // above); this is the mouse sibling it never wrote — we compute the
        // TextSelection ourselves instead of trusting the broken native drag.
        // Scoped tightly: we ONLY take over when the press lands at the trailing
        // after-chip spot. Everywhere else (plain text, and between-chip
        // positions, which drag fine natively) we return false and the native
        // drag is untouched, so the blast radius is exactly the broken case.
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
          const at = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          });
          if (!at) return false;
          if (!isTrailingCaretBlind(view.state.doc.resolve(at.pos))) {
            return false;
          }
          event.preventDefault();
          const anchor = at.pos;
          view.focus();
          view.dispatch(
            view.state.tr.setSelection(
              TextSelection.create(view.state.doc, anchor),
            ),
          );
          /**
           * Extends the takeover selection to the mouse's current position.
           * @param move - The mousemove event.
           */
          const onMove = (move: MouseEvent): void => {
            const head = view.posAtCoords({
              left: move.clientX,
              top: move.clientY,
            });
            if (!head) return;
            view.dispatch(
              view.state.tr.setSelection(
                TextSelection.create(view.state.doc, anchor, head.pos),
              ),
            );
          };
          /** Tears down the takeover's document listeners on mouse release. */
          const onUp = (): void => {
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
          };
          document.addEventListener('mousemove', onMove, true);
          document.addEventListener('mouseup', onUp, true);
          return true;
        },
      },
      decorations(state): DecorationSet | null {
        if (!referenceMentionCaretKey.getState(state)) return null;
        const pos = caretBlindPos(state);
        if (pos === null) return null;
        return DecorationSet.create(state.doc, [
          Decoration.widget(pos, renderCaret, {
            key: 'reference-mention-caret',
          }),
        ]);
      },
      // Class attrs from multiple sources concatenate, so this only ever ADDS
      // the marker class; {} contributes nothing while the caret is idle.
      attributes(state): Record<string, string> {
        if (!referenceMentionCaretKey.getState(state)) return {};
        return caretBlindPos(state) === null
          ? {}
          : { class: REFERENCE_MENTION_CARET_ACTIVE_CLASS };
      },
    },
  });
}
