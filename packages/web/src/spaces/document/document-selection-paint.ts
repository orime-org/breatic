// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A block with no text inside the reader's selection is drawn as selected
 * (#124).
 *
 * The browser paints a selection over text only, so a divider or a fallback
 * block inside a selection looks exactly like one outside it. This marks such
 * a block with a class, and `index.css` paints that class with the colour the
 * browser uses for selected text — one look however the block got selected
 * (user 2026-09-30).
 *
 * WHICH SELECTIONS. A range that is not empty (a drag, Shift with an arrow,
 * select-all) paints every no-text block wholly inside it. A node selection
 * paints only a divider: the reader makes one by clicking a divider or walking
 * onto it with the arrows, and the 2026-09-18 rule that the machinery's own
 * node selections are not drawn (`index.css:558`) stays for every other block.
 *
 * WHEN. Only while the reader can see a selection at all. In an editable body
 * that is while it holds the focus. A read-only body never takes the focus —
 * it has no tabindex (`@tiptap/core` `extensions/tabindex.ts`) — yet the
 * browser still paints the words a viewer drags across, so there it is while
 * the browser's own selection sits inside the body. Either way
 * `ShowSelectionExtension` standing in for the selection while a panel holds
 * it (`DocumentLinkPopover.tsx:297-303`) counts too. Outside those the browser
 * stops painting text, and a block painted on its own would read as the only
 * thing selected.
 */

import { createExtension } from '@blocknote/core';
import { ShowSelectionExtension } from '@blocknote/core/extensions';
import { AllSelection, NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import { UNSUPPORTED_BLOCK } from '@web/spaces/document/document-unsupported-blocknote';
import { DIVIDER } from '@web/spaces/document/document-divider';

/** The class `index.css` paints a no-text block inside the selection with. */
export const IN_SELECTION_CLASS = 'doc-in-selection';


/** The blocks with no text that a range selection paints. */
const NO_TEXT = new Set([DIVIDER, UNSUPPORTED_BLOCK]);

/** Tags the transaction a focus change sends to have the band redrawn. */
const KEY = new PluginKey('documentSelectionPaint');

/**
 * The decorations for the blocks the current selection holds.
 * @param state - The editor state.
 * @returns The set, empty when nothing is to be painted.
 */
function paintFor(state: EditorState): DecorationSet {
  const { selection, doc } = state;
  const found: Decoration[] = [];
  if (selection instanceof NodeSelection) {
    if (selection.node.type.name === DIVIDER) {
      found.push(
        Decoration.node(selection.from, selection.to, { class: IN_SELECTION_CLASS }),
      );
    }
  } else if (selection instanceof AllSelection || !selection.empty) {
    const { from, to } = selection;
    doc.nodesBetween(from, to, (node, pos) => {
      if (node.isTextblock) return false;
      if (NO_TEXT.has(node.type.name)) {
        if (pos >= from && pos + node.nodeSize <= to) {
          found.push(
            Decoration.node(pos, pos + node.nodeSize, { class: IN_SELECTION_CLASS }),
          );
        }
        return false;
      }
      return true;
    });
  }
  return found.length > 0 ? DecorationSet.create(doc, found) : DecorationSet.empty;
}

/**
 * The extension that paints no-text blocks inside the selection.
 * @returns The extension, for the assembly to register.
 */
export const documentSelectionPaintExtension = createExtension(({ editor }) => {
  /**
   * Whether a panel is standing in for the selection right now.
   * @returns True while `ShowSelectionExtension` holds any key.
   */
  const shownByPanel = (): boolean =>
    (editor.getExtension(ShowSelectionExtension)?.store.state.enabledSet.size ?? 0) > 0;

  /** The view, once mounted: focus is a property of the view, not of the state. */
  let mounted: EditorView | null = null;

  /**
   * Asks for the decorations again. Focus and the browser's selection change
   * no state, so without this the band would stand until the next edit.
   * @param view - The view to redraw.
   * @returns False, so the event carries on to everyone else.
   */
  const redraw = (view: EditorView): boolean => {
    view.dispatch(view.state.tr.setMeta(KEY, true).setMeta('addToHistory', false));
    return false;
  };

  /**
   * Whether the reader can see a selection in this body right now.
   * @param view - The view.
   * @returns True while the band belongs on screen.
   */
  const visible = (view: EditorView): boolean => {
    if (view.editable) return view.hasFocus();
    const selection = view.dom.ownerDocument.getSelection();
    return (
      selection !== null &&
      selection.rangeCount > 0 &&
      view.dom.contains(selection.anchorNode)
    );
  };

  return {
    key: 'document-selection-paint',
    prosemirrorPlugins: [
      new Plugin({
        key: KEY,
        view: (view) => {
          mounted = view;
          /** Redraws a read-only body when the browser's selection moves. */
          const onSelectionChange = (): void => {
            if (!view.editable) redraw(view);
          };
          view.dom.ownerDocument.addEventListener('selectionchange', onSelectionChange);
          return {
            destroy: () => {
              view.dom.ownerDocument.removeEventListener(
                'selectionchange',
                onSelectionChange,
              );
              mounted = null;
            },
          };
        },
        props: {
          handleDOMEvents: { focus: redraw, blur: redraw },
          decorations: (state) =>
            (mounted !== null && visible(mounted)) || shownByPanel()
              ? paintFor(state)
              : DecorationSet.empty,
        },
      }),
    ],
  } as never;
});
