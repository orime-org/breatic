// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The browser's view of the table whose specs live in
 * `@breatic/shared/document-model` (breatic#1488 §11.1): the horizontal
 * frame of `DocumentTableScroller` the table sits in, and the paste rule that
 * keeps a pasted table whole. {@link documentTableView} attaches both to the
 * shared specs; neither changes the schema.
 */

import { cellDepthOf, DOC_TABLE, type DocTableView } from '@breatic/shared/document-model';
import { Slice, type Fragment } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { createRoot, type Root } from 'react-dom/client';

import { DocumentTableScroller } from '@web/spaces/document/DocumentTableScroller';
import { heldTables } from '@web/spaces/document/document-table-leave-selection';

/**
 * Puts the table into the horizontal frame of `DocumentTableScroller`. The
 * table is attached before ProseMirror reads its content DOM. React owns a
 * separate chrome host, and the slot moves that same table into its viewport
 * when the frame commits. A view can be created inside a React effect.
 * @param host - The element the frame is drawn in.
 * @param table - The `<table>`.
 * @param scrollLeft - Where the frame starts scrolled to sideways.
 * @returns The React root, to unmount when the view goes.
 */
function mountScroller(host: HTMLElement, table: HTMLElement, scrollLeft = 0): Root {
  const chrome = document.createElement('div');
  chrome.className = 'contents';
  host.append(table, chrome);
  const root = createRoot(chrome);
  root.render(
    <DocumentTableScroller>
      <div
        className='tableWrapper'
        ref={(slot) => {
          if (slot === null || table.parentElement === slot) return;
          slot.appendChild(table);
          const viewport = slot.closest<HTMLElement>('[data-radix-scroll-area-viewport]');
          if (viewport !== null && scrollLeft > 0) viewport.scrollLeft = scrollLeft;
        }}
      />
    </DocumentTableScroller>,
  );
  return root;
}

/**
 * Puts a table drawn as static HTML (`blocksToFullHTML`) in the frame the
 * body's node view draws around its own: the same `doc-table` and
 * `doc-table-scroller` elements, scrolled sideways by
 * `DocumentTableScroller`. The serialiser stamps the block's attributes on
 * the `<table>`; the node view has them on the frame, where the body's table
 * rules look for them, so they move there.
 * @param table - The `<table>`, in its place.
 * @param scrollLeft - Where the frame starts scrolled to sideways.
 * @returns The React root, to unmount when the copy goes.
 */
export function frameStaticTable(table: HTMLTableElement, scrollLeft = 0): Root {
  const dom = document.createElement('div');
  dom.className = 'doc-table';
  for (const { name, value } of [...table.attributes]) {
    if (!name.startsWith('data-')) continue;
    dom.setAttribute(name, value);
    table.removeAttribute(name);
  }
  const host = document.createElement('div');
  host.className = 'doc-table-scroller';
  dom.appendChild(host);
  table.replaceWith(dom);
  return mountScroller(host, table, scrollLeft);
}

/**
 * How far a slice may stay open at one side and still keep its tables
 * closed: the depth of the first table along that side's edge, or the open
 * depth when no table is on it.
 * @param content - The slice's content.
 * @param open - How deep that side is open.
 * @param side - -1 for the start, 1 for the end.
 * @returns The open depth to use.
 */
function openAboveTables(content: Fragment, open: number, side: -1 | 1): number {
  let node = side < 0 ? content.firstChild : content.lastChild;
  for (let depth = 0; node !== null && depth < open; depth += 1) {
    if (node.type.spec['tableRole'] === 'table') return depth;
    node = side < 0 ? node.firstChild : node.lastChild;
  }
  return open;
}

/**
 * A slice with the wrappers it is open through on both sides taken off: one
 * whose only child is open at both ends carries that child's content one
 * level down. A table left inside a wrapper open at both sides is fitted into
 * the line around the caret, its cells' words joining it; a table at the top
 * of a closed slice is placed as a block.
 * @param slice - The slice.
 * @returns The slice without those wrappers.
 */
function unwrapOpenSides(slice: Slice): Slice {
  let { content, openStart, openEnd } = slice;
  while (openStart > 0 && openEnd > 0 && content.childCount === 1) {
    content = content.firstChild!.content;
    openStart -= 1;
    openEnd -= 1;
  }
  return new Slice(content, openStart, openEnd);
}

/**
 * A pasted slice with its tables kept whole. A layout block's node is never
 * isolating (BlockNote `meta.ts`), so a slice opened through a table would
 * join its first or last cell's block with the block around the caret and
 * leave the cell without it. Closing the slice at the table lands the table
 * as a block: in the middle of a line the line splits around it, at its end
 * the table goes under it, and at its start above it, the line kept whole.
 * It reads its target from the selection, so it runs once the selection is
 * on the target (inner#1351 design §5.4.3 "the slice transformed once on the
 * target").
 * @param slice - The slice.
 * @param view - The view, its selection on the target.
 * @returns The slice.
 */
export function keepTablesWhole(slice: Slice, view: EditorView): Slice {
  const start = openAboveTables(slice.content, slice.openStart, -1);
  const end = openAboveTables(slice.content, slice.openEnd, 1);
  if (start === slice.openStart && end === slice.openEnd) return slice;
  const closed = new Slice(slice.content, start, end);
  const { selection } = view.state;
  // A cell holds blocks but no table, so a table pasted in a cell is fitted
  // into the cell; what a paste into a cell does is inner#1312's.
  return cellDepthOf(selection.$from) > 0 && heldTables(selection) === null ? closed : unwrapOpenSides(closed);
}

/** Keeps tables whole on ProseMirror's own paste (`keepTablesWhole`). */
const keepPastedTablesWhole = new Plugin({
  key: new PluginKey('doc-table-paste-whole'),
  props: {
    transformPasted: (slice, view) => keepTablesWhole(slice, view),
    // At the start of a line with words, ProseMirror splits the line before
    // the table and leaves its empty first half above it.
    handlePaste: (view, _event, slice) => {
      const { selection } = view.state;
      const { $from } = selection;
      const first = slice.content.firstChild;
      if (!selection.empty || slice.openStart !== 0 || slice.openEnd !== 0 || first?.type.name !== DOC_TABLE) return false;
      if (cellDepthOf($from) > 0) return false;
      if ($from.parentOffset !== 0 || $from.parent.content.size === 0 || $from.node($from.depth - 1).type.name !== 'blockContainer') return false;
      view.dispatch(view.state.tr.insert($from.before($from.depth - 1), slice.content).scrollIntoView());
      return true;
    },
  },
});

/** What this editor adds to the shared table specs. */
export const documentTableView: DocTableView = {
  mountFrame: mountScroller,
  plugins: [keepPastedTablesWhole],
};
