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

import type { Node as PMNode } from '@tiptap/pm/model';
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
 * Whether a node is a reference-mention chip.
 * @param node - The adjacent node (null at a paragraph edge).
 * @returns True for a reference-mention atom.
 */
function isChip(node: PMNode | null): boolean {
  return node?.type.name === REFERENCE_MENTION_NODE;
}

/**
 * Resolves the document position where the fake caret must render: an empty
 * text cursor whose position has NO adjacent text node (nothing for the
 * browser to anchor a native caret to) and at least one adjacent reference
 * chip. Everywhere else — including an empty paragraph, where ProseMirror's
 * trailing break keeps the native caret visible — the native caret is in
 * charge and this returns null.
 * @param state - The editor state.
 * @returns The caret-blind position, or null when the native caret suffices.
 */
export function caretBlindPos(state: EditorState): number | null {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return null;
  const $pos = sel.$from;
  if (!$pos.parent.inlineContent) return null;
  const before = $pos.nodeBefore;
  const after = $pos.nodeAfter;
  if (before?.isText === true || after?.isText === true) return null;
  if (!isChip(before) && !isChip(after)) return null;
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
