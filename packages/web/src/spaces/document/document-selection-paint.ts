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
 * paints only a divider or a media block: the reader makes one by clicking it
 * or walking onto it with the arrows, and the 2026-09-18 rule that the machinery's own
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
  bodyEdgeAt,
  emptyEdgeLinePos,
  type BodyEdge,
} from '@web/spaces/document/document-body-edge-selection';
import { UNSUPPORTED_BLOCK } from '@web/spaces/document/document-unsupported-blocknote';
import { DIVIDER } from '@web/spaces/document/document-divider';

/** The class `index.css` paints a no-text block inside the selection with. */
export const IN_SELECTION_CLASS = 'doc-in-selection';

/**
 * The class `index.css` marks an empty line with: an empty line an end of a
 * range sits on, and the empty line at an end of the body that a selection
 * past that end, or the whole document, holds.
 */
export const EMPTY_LINE_CLASS = 'doc-empty-line-in-selection';

/**
 * The class `index.css` frames an image, video or audio block inside the
 * selection with. A band behind the media would fill the rest of its row; the
 * frame sits on the media itself (inner#1127).
 */
export const MEDIA_IN_SELECTION_CLASS = 'doc-media-in-selection';

/** The image, video and audio blocks. */
const MEDIA = new Set(['image', 'video', 'audio']);

/** The blocks with no text that a range selection paints. */
const NO_TEXT = new Set([DIVIDER, UNSUPPORTED_BLOCK, ...MEDIA]);

/** The blocks the reader node-selects by clicking them or arrowing onto them. */
const NODE_SELECTED = new Set([DIVIDER, ...MEDIA]);

/**
 * The class a no-text block in the selection is painted with.
 * @param name - The block's node name.
 * @returns The frame for a media block, the band for the rest.
 */
function paintClassOf(name: string): string {
  return MEDIA.has(name) ? MEDIA_IN_SELECTION_CLASS : IN_SELECTION_CLASS;
}

/** Tags the transaction that asks for the band to be redrawn. */
const KEY = new PluginKey('documentSelectionPaint');

/**
 * The empty lines a range holds at its ends (#124): the empty line at an end
 * of the body that a selection reaching past it, or one holding the whole
 * document, holds; and any empty line an end of a text range sits on. An empty
 * line has one position, so a range ending there holds the line — deleting the
 * range takes it — yet the browser marks it only when the range runs over it,
 * and the one at an end of the body only once the range is written back to the
 * page, which during a drag in Chrome it is not. Marked here, `index.css` draws
 * the browser's sliver itself and clears the browser's own, so the line shows
 * one mark throughout, the same one any selected empty line shows.
 * @param selection - The selection.
 * @param doc - The document.
 * @returns A decoration per empty line the selection holds at an end.
 */
function emptyLinesAtEnds(selection: Selection, doc: PMNode): Decoration[] {
  const edges: BodyEdge[] =
    selection instanceof AllSelection
      ? ['start', 'end']
      : [selection.anchor, selection.head].flatMap((end) => bodyEdgeAt(doc, end) ?? []);
  const atEdges = edges.flatMap((edge) => emptyEdgeLinePos(doc, edge) ?? []);
  const atText = [selection.anchor, selection.head].flatMap((end) => {
    const $end = doc.resolve(end);
    return $end.parent.isTextblock && $end.parent.content.size === 0 ? [$end.before()] : [];
  });
  return [...new Set([...atEdges, ...atText])].map((pos) =>
    Decoration.node(pos, pos + doc.nodeAt(pos)!.nodeSize, { class: EMPTY_LINE_CLASS }),
  );
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
    if (NODE_SELECTED.has(selection.node.type.name)) {
      found.push(
        Decoration.node(selection.from, selection.to, {
          class: paintClassOf(selection.node.type.name),
        }),
      );
    }
  } else if (!selection.empty) {
    // A no-text block is a leaf of size one, so reaching it here means the
    // range holds all of it.
    doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      if (node.isTextblock) return false;
      if (!NO_TEXT.has(node.type.name)) return true;
      found.push(Decoration.node(pos, pos + node.nodeSize, { class: paintClassOf(node.type.name) }));
      return false;
    });
    found.push(...emptyLinesAtEnds(selection, doc));
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
