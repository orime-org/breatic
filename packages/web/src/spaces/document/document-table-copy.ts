// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Copying and cutting where a table whose cells hold blocks is involved
 * (inner#1619 design 5.7).
 *
 * BlockNote's copy (`copyExtension.ts`) reads a cell selection as cells of
 * words alone, which comes out empty for cells that hold blocks, writes the
 * plain text through its Markdown export, which flattens every cell of a
 * table to its words, and copies words in one cell inside the table around
 * them. Here, ahead of it:
 *
 * - selected cells copy as a table of those cells, their blocks kept, and a
 *   cut then empties them;
 * - words in one cell copy as the cell's blocks, without the table;
 * - a selection that takes a table whole copies that table whole
 *   (`heldRange`), from the table's edge;
 * - any other selection that holds a table copies as BlockNote copies it,
 *   with the plain text the Agent reads (`blocksMarkdown`).
 *
 * Every other selection is BlockNote's.
 */

import {
  createExtension,
  fragmentToBlocks,
  nodeToBlock,
  selectedFragmentToHTML,
  type BlockNoteEditor,
} from '@blocknote/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Selection } from '@tiptap/pm/state';
import { CellSelection, deleteCellSelection } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';

import { blocksMarkdown } from '@web/spaces/document/document-table-markdown';
import { heldRange } from '@web/spaces/document/document-table-leave-selection';
import { cellDepthOf, DOC_TABLE } from '@web/spaces/document/document-table-nodes';

/** The editor, as far as copying reads it. */
type CopyEditor = BlockNoteEditor<never, never, never>;

/** What goes on the clipboard. */
interface Clipped {
  readonly internal: string;
  readonly external: string;
  readonly plain: string;
}

/**
 * The cell both ends of a selection are in, when they are in one.
 * @param selection - The selection.
 * @returns The cell's depth, or -1.
 */
function oneCellDepth(selection: Selection): number {
  const { $from, $to } = selection;
  const depth = cellDepthOf($from);
  return depth > 0 && $to.depth >= depth && $to.node(depth) === $from.node(depth) ? depth : -1;
}

/**
 * Whether a selection's range holds a whole table or part of one.
 * @param selection - The selection.
 * @returns True when a table is in it.
 */
function holdsTable(selection: Selection): boolean {
  let found = false;
  selection.$from.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.type.name === DOC_TABLE) found = true;
    return !found;
  });
  return found;
}

/**
 * The internal HTML of a slice, as ProseMirror writes it for its own paste.
 * @param view - The editor view.
 * @param slice - The slice.
 * @returns The HTML.
 */
function internalHTML(view: EditorView, slice: Slice): string {
  return view.serializeForClipboard(slice).dom.innerHTML;
}

/**
 * The blocks a copy of the selection carries where it is not BlockNote's to
 * write, and the slice ProseMirror pastes back from them.
 */
export interface ClippedBlocks {
  readonly blocks: never[];
  /** The slice for the internal HTML, or null where the selection's own export writes it. */
  readonly slice: Slice | null;
}

/**
 * Selected cells, as a table of those cells.
 * @param view - The editor view.
 * @param selection - The cell selection.
 * @returns The blocks and the slice.
 */
function cellsBlocks(view: EditorView, selection: CellSelection): ClippedBlocks {
  const slice = selection.content();
  const first = slice.content.firstChild;
  // prosemirror-tables hands the whole table when every cell is selected, and
  // its rows otherwise.
  const table =
    first?.type.name === DOC_TABLE ? first : view.state.schema.nodes[DOC_TABLE]!.create(null, slice.content);
  return { blocks: [nodeToBlock(table, view.state.doc) as never], slice };
}

/**
 * Words in one cell, as the cell's blocks.
 * @param view - The editor view.
 * @param depth - The cell's depth.
 * @returns The blocks and the slice.
 */
function inCellBlocks(view: EditorView, depth: number): ClippedBlocks {
  const { selection } = view.state;
  // A selection's content carries every node from the document down to the
  // ends; the levels down to the cell are the table around the words, and
  // what is left is what the cell holds (Outline `TableCell.ts`
  // `transformCopied` cuts the same levels).
  const whole = selection.content();
  let content: Fragment = whole.content;
  for (let level = 0; level < depth; level += 1) {
    content = content.firstChild?.content ?? Fragment.empty;
  }
  const slice = new Slice(content, Math.max(0, whole.openStart - depth), Math.max(0, whole.openEnd - depth));
  return { blocks: fragmentToBlocks(content as never) as never[], slice };
}

/**
 * The blocks a copy of the selection carries, where it is not BlockNote's to
 * write: selected cells, words in one cell, or a range holding a table.
 * @param view - The editor view.
 * @returns The blocks, or null to leave the copy to BlockNote.
 */
export function tableClippedBlocks(view: EditorView): ClippedBlocks | null {
  const { selection } = view.state;
  if (selection.empty) return null;
  if (selection instanceof CellSelection) return cellsBlocks(view, selection);
  const depth = oneCellDepth(selection);
  if (depth > 0) return inCellBlocks(view, depth);
  // A selection leaving a table carries the whole table (inner#1619 T14).
  const held = heldRange(selection);
  if (held !== null) {
    const slice = view.state.doc.slice(held.from, held.to);
    // The blocks are read with the nodes around the range: when both ends
    // share a block, the table nested under it, the range opens inside that
    // block and its own words sit outside any block of their own.
    const whole = view.state.doc.slice(held.from, held.to, true);
    return { blocks: fragmentToBlocks(whole.content as never) as never[], slice };
  }
  if (!holdsTable(selection)) return null;
  return { blocks: fragmentToBlocks(selection.content().content as never) as never[], slice: null };
}

/**
 * What a copy of the selection puts on the clipboard, where it is not
 * BlockNote's to write.
 * @param editor - The editor.
 * @param view - The editor view.
 * @returns The clipboard, or null to leave the copy to BlockNote.
 */
export function tableClipped(editor: CopyEditor, view: EditorView): Clipped | null {
  const picked = tableClippedBlocks(view);
  if (picked === null) return null;
  const plain = blocksMarkdown(editor, picked.blocks);
  if (picked.slice === null) {
    const { clipboardHTML, externalHTML } = selectedFragmentToHTML(view, editor);
    return { internal: clipboardHTML, external: externalHTML, plain };
  }
  return { internal: internalHTML(view, picked.slice), external: editor.blocksToHTMLLossy(picked.blocks), plain };
}

/**
 * Writes what a copy carries onto the clipboard.
 * @param event - The copy or cut.
 * @param clipped - What it carries.
 */
function write(event: ClipboardEvent, clipped: Clipped): void {
  const data = event.clipboardData;
  if (data === null) return;
  event.preventDefault();
  data.clearData();
  data.setData('blocknote/html', clipped.internal);
  data.setData('text/html', clipped.external);
  data.setData('text/plain', clipped.plain);
}

/**
 * The extension that takes these copies and cuts.
 * @returns The extension, for the assembly to register.
 */
export const documentTableCopyExtension = createExtension(({ editor }) => ({
  key: 'documentTableCopy',
  prosemirrorPlugins: [
    new Plugin({
      key: new PluginKey('documentTableCopy'),
      props: {
        handleDOMEvents: {
          copy: (view, event) => {
            const clipped = tableClipped(editor as unknown as CopyEditor, view);
            if (clipped === null) return false;
            write(event, clipped);
            return true;
          },
          cut: (view, event) => {
            const clipped = tableClipped(editor as unknown as CopyEditor, view);
            if (clipped === null) return false;
            write(event, clipped);
            if (!view.editable) return true;
            if (view.state.selection instanceof CellSelection) {
              deleteCellSelection(view.state, view.dispatch);
            } else {
              view.dispatch(view.state.tr.deleteSelection());
            }
            return true;
          },
        },
      },
    }),
  ],
}));
