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
import type { Node as PMNode } from '@tiptap/pm/model';
import { AllSelection, NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Selection } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import {
  BodyEdgeSelection,
  bodyEdgeAt,
  emptyEdgeLinePos,
  type BodyEdge,
} from '@web/spaces/document/document-body-edge-selection';
import { UNSUPPORTED_BLOCK } from '@web/spaces/document/document-unsupported-blocknote';
import { DIVIDER } from '@web/spaces/document/document-divider';

/** The class `index.css` paints a no-text block inside the selection with. */
export const IN_SELECTION_CLASS = 'doc-in-selection';

/**
 * The class `index.css` marks an empty line at an end of the body with, when a
 * selection reaching past that end holds it.
 */
export const EMPTY_LINE_CLASS = 'doc-empty-line-in-selection';

/** The blocks with no text that a range selection paints. */
const NO_TEXT = new Set([DIVIDER, UNSUPPORTED_BLOCK]);

/** Tags the transaction that asks for the band to be redrawn. */
const KEY = new PluginKey('documentSelectionPaint');

/**
 * The empty line at an end of the body that a selection reaching past it, or
 * one holding the whole document, holds (#124). The browser marks an empty line inside a range with a sliver at its
 * start, but the one at an end only once the range is written back to the
 * page, which during a drag in Chrome it is not. Marked here, `index.css` draws
 * that sliver itself from the first frame of the drag and clears the
 * browser's, so the line shows one mark throughout, the same one any selected
 * empty line shows.
 * @param selection - The selection.
 * @param doc - The document.
 * @returns A decoration per empty line on an edge the selection reaches.
 */
function emptyEdgeLines(selection: Selection, doc: PMNode): Decoration[] {
  const edges: BodyEdge[] =
    selection instanceof AllSelection
      ? ['start', 'end']
      : selection instanceof BodyEdgeSelection
        ? [selection.anchor, selection.head].flatMap((end) => bodyEdgeAt(doc, end) ?? [])
        : [];
  return edges.flatMap((edge) => {
    const pos = emptyEdgeLinePos(doc, edge);
    return pos === null ? [] : [Decoration.node(pos, pos + doc.nodeAt(pos)!.nodeSize, { class: EMPTY_LINE_CLASS })];
  });
}

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
  } else if (!selection.empty) {
    // A no-text block is a leaf of size one, so reaching it here means the
    // range holds all of it.
    doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      if (node.isTextblock) return false;
      if (!NO_TEXT.has(node.type.name)) return true;
      found.push(Decoration.node(pos, pos + node.nodeSize, { class: IN_SELECTION_CLASS }));
      return false;
    });
    found.push(...emptyEdgeLines(selection, doc));
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
   * Asks for the decorations again. A focus change needs none of this: tiptap's
   * own focus handling dispatches a transaction on focus and on blur. The
   * browser's selection moving in a read-only body changes no state at all.
   * @param view - The view to redraw.
   */
  const redraw = (view: EditorView): void => {
    view.dispatch(view.state.tr.setMeta(KEY, true).setMeta('addToHistory', false));
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
          /** What the band last showed, so a redraw goes out only on a change. */
          let shown = false;
          /**
           * Redraws a read-only body when the browser's selection moves into
           * or out of it. `selectionchange` fires for every caret move
           * anywhere on the page, and while the answer stays the same the
           * editor's own selection transaction already repaints the band.
           */
          const onSelectionChange = (): void => {
            if (view.editable) return;
            const now = visible(view);
            if (now !== shown) {
              shown = now;
              redraw(view);
            }
          };
          view.dom.ownerDocument.addEventListener('selectionchange', onSelectionChange);
          return {
            // What the band shows is decided on every update, whatever sent
            // it; keeping `shown` to that is what lets the listener above tell
            // a real change from none.
            update: (updated) => {
              shown = visible(updated);
            },
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
          decorations: (state) =>
            (mounted !== null && visible(mounted)) || shownByPanel()
              ? paintFor(state)
              : DecorationSet.empty,
        },
      }),
    ],
  } as never;
});
