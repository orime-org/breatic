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
 * 0px separator img widget decoration at each. The widget's `raw: true` skips
 * PM's contentEditable=false wrapping (which would re-create the unanchorable
 * island), and its parseRule `{ignore: true}` keeps it out of the model — zero
 * Yjs sync, zero offset drift. This replaced the earlier display-only fake caret,
 * which never participated in the native selection so it could not fix WebKit's
 * wrong insertion point (A, user 2026-07-12). All imports come from `@tiptap/pm`
 * so the plugin shares TipTap's single prosemirror instance.
 *
 * NOTE (Safari, unverified): PM proves the separator anchors a WebKit caret only
 * at the trailing position; whether it holds mid-line must be verified on real
 * WebKit. The mouse takeover + one-press chip crossing are retained meanwhile.
 */

import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { REFERENCE_MENTION_NODE } from '@web/spaces/canvas/generate/at-reference';

/** Identifies the caret/anchor plugin (tests resolve the live plugin through it). */
export const referenceMentionCaretKey = new PluginKey('referenceMentionCaret');

/**
 * CSS class of PM's separator img — the native-caret anchor. index.css sizes it
 * 0x0 (a non-zero box nudges the following chip AND re-breaks Chrome's native
 * drag hit-test, tiptap #4646).
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
 * Creates the chip-boundary caret/anchor plugin (installed by the
 * ReferenceMention extension): injects a raw `img.ProseMirror-separator` at every
 * caret-blind chip gap so the browser anchors + places a NATIVE caret there —
 * click, drag-select and typing all flow through native selection once the anchor
 * exists (the earlier fake caret + mouse takeover + click/geometry handlers were
 * retired in A once real-browser verification confirmed native works, user
 * 2026-07-12). Its one keymap — one-press chip crossing (P5) — is an independent
 * UX choice unrelated to anchoring. The anchors are structural (no focus gate: a
 * native caret only renders in a focused editor, and the 0-width anchor is
 * invisible otherwise).
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
