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
 * paints only a divider: the reader makes one by clicking it or walking onto
 * it with the arrows, and the 2026-09-18 rule that the machinery's own node
 * selections are not drawn (`index.css`, "A node-selected block is not drawn") stays for every other block. A
 * media block the reader selects draws itself (see `NODE_SELECTED`). An edge
 * takeover (`BodyEdgeSelection`) has its text drawn here too, and the native
 * selection hidden: during a pull the page selection is still the browser's
 * own, not the takeover's (inner#1350 A8).
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
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import { BodyEdgeSelection } from '@web/spaces/document/document-body-edge-selection';
import { bodyHolds } from '@web/spaces/document/document-body-focus';
import { UNSUPPORTED_BLOCK } from '@web/spaces/document/document-unsupported-blocknote';
import { DIVIDER } from '@web/spaces/document/document-divider';
import { heldRange } from '@web/spaces/document/document-table-leave-selection';
import { MEDIA_BLOCK_TYPES, isMediaBlockType } from '@web/spaces/document/document-media-types';

/** The class `index.css` paints a no-text block inside the selection with. */
export const IN_SELECTION_CLASS = 'doc-in-selection';

/**
 * The body's attribute while the selection is one the body draws itself — a
 * cell selection or an edge takeover; `index.css` draws no native selection
 * under it.
 */
export const SELECTION_DRAWN_ATTR = 'data-selection-drawn';

/**
 * The class `index.css` marks every empty line a selection holds with (#124).
 * An empty line has one position, so a range that holds it takes it when
 * deleted, yet only Chromium marks a selected empty line itself, and the one at
 * an end of the body only once the range is written back to the page, which
 * during a drag in Chrome it is not; a range the body draws (an edge takeover)
 * clears the browser's mark entirely. Marked here, `index.css` draws the
 * browser's sliver itself and clears the browser's own, so a selected empty
 * line shows one mark in every browser, however it was selected. A cell
 * selection holds cells, not the lines between its ends.
 */
export const EMPTY_LINE_CLASS = 'doc-empty-line-in-selection';

/**
 * The class `index.css` frames an image, video or audio block inside the
 * selection with. A band behind the media would fill the rest of its row; the
 * frame sits on the media itself (inner#1127).
 */
export const MEDIA_IN_SELECTION_CLASS = 'doc-media-in-selection';


/** The blocks with no text that a range selection paints. */
const NO_TEXT = new Set<string>([DIVIDER, UNSUPPORTED_BLOCK, ...MEDIA_BLOCK_TYPES]);

/**
 * The node selections painted here. A media block the reader selected draws
 * its own frame, with its corner knobs and its toolbar, off its own selected
 * state (`DocumentMediaBlock`), so all of it comes and goes together.
 */
const NODE_SELECTED = new Set([DIVIDER]);

/**
 * The class a no-text block in the selection is painted with.
 * @param name - The block's node name.
 * @returns The frame for a media block, the band for the rest.
 */
function paintClassOf(name: string): string {
  return isMediaBlockType(name) ? MEDIA_IN_SELECTION_CLASS : IN_SELECTION_CLASS;
}

/** Tags the transaction that asks for the band to be redrawn. */
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
    if (NODE_SELECTED.has(selection.node.type.name)) {
      found.push(
        Decoration.node(selection.from, selection.to, {
          class: paintClassOf(selection.node.type.name),
        }),
      );
    }
  } else if (!selection.empty) {
    // A no-text block is a leaf of size one, so reaching it here means the
    // range holds all of it; so does an empty line, whose one position lies
    // inside any range that reaches it. A selection taking a table whole
    // holds the blocks without words at the edges of its cells too
    // (inner#1619 T14), which lie past its ends.
    const holdsLines = !(selection instanceof CellSelection);
    const range = heldRange(selection) ?? selection;
    doc.nodesBetween(range.from, range.to, (node, pos) => {
      if (node.isTextblock) {
        if (holdsLines && node.content.size === 0) {
          found.push(Decoration.node(pos, pos + node.nodeSize, { class: EMPTY_LINE_CLASS }));
        }
        return false;
      }
      if (!NO_TEXT.has(node.type.name)) return true;
      found.push(Decoration.node(pos, pos + node.nodeSize, { class: paintClassOf(node.type.name) }));
      return false;
    });
    // The text an edge takeover holds, in the colour the panel stand-in
    // paints with (`index.css`, `[data-show-selection]`).
    if (selection instanceof BodyEdgeSelection) {
      found.push(Decoration.inline(selection.from, selection.to, { 'data-show-selection': 'true' }));
    }
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
    // An editable body draws what is selected while it holds the focus, which
    // counts its own layers (a menu, a confirm dialog) as the body.
    if (view.editable) return bodyHolds(view.state);
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
          // A cell selection draws its cells (`.selectedCell`) and an edge
          // takeover its range (`paintFor`), and neither the native selection:
          // the page selection is not theirs while the mouse is down, as
          // Chrome holds ProseMirror's write back until the release
          // (`selectionToDOM`). The attribute takes effect on the transaction,
          // so what a pull shows is what it keeps (inner#1350 design §5.7).
          attributes: (state): Record<string, string> =>
            state.selection instanceof CellSelection || state.selection instanceof BodyEdgeSelection
              ? { [SELECTION_DRAWN_ATTR]: '' }
              : {},
        },
      }),
    ],
  } as never;
});
