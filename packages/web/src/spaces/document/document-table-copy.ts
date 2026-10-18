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
 * - a selection that holds a table copies as BlockNote copies it, with the
 *   plain text the Agent reads (`blocksMarkdown`).
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
import { DOC_TABLE, isTableCell } from '@web/spaces/document/document-table-nodes';

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
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if (isTableCell($from.node(depth))) {
      return $to.depth >= depth && $to.node(depth) === $from.node(depth) ? depth : -1;
    }
  }
  return -1;
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
 * Selected cells, as a table of those cells.
 * @param editor - The editor.
 * @param view - The editor view.
 * @param selection - The cell selection.
 * @returns What goes on the clipboard.
 */
function cellsClipped(editor: CopyEditor, view: EditorView, selection: CellSelection): Clipped {
  const slice = selection.content();
  const first = slice.content.firstChild;
  // prosemirror-tables hands the whole table when every cell is selected, and
  // its rows otherwise.
  const table =
    first?.type.name === DOC_TABLE ? first : view.state.schema.nodes[DOC_TABLE]!.create(null, slice.content);
  const block = nodeToBlock(table, view.state.doc) as never;
  return {
    internal: internalHTML(view, slice),
    external: editor.blocksToHTMLLossy([block]),
    plain: blocksMarkdown(editor, [block]),
  };
}

/**
 * Words in one cell, as the cell's blocks.
 * @param editor - The editor.
 * @param view - The editor view.
 * @param depth - The cell's depth.
 * @returns What goes on the clipboard.
 */
function inCellClipped(editor: CopyEditor, view: EditorView, depth: number): Clipped {
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
  const blocks = fragmentToBlocks(content as never) as never[];
  return {
    internal: internalHTML(view, slice),
    external: editor.blocksToHTMLLossy(blocks),
    plain: blocksMarkdown(editor, blocks),
  };
}

/**
 * What a copy of the selection puts on the clipboard, where it is not
 * BlockNote's to write.
 * @param editor - The editor.
 * @param view - The editor view.
 * @returns The clipboard, or null to leave the copy to BlockNote.
 */
export function tableClipped(editor: CopyEditor, view: EditorView): Clipped | null {
  const { selection } = view.state;
  if (selection.empty) return null;
  if (selection instanceof CellSelection) return cellsClipped(editor, view, selection);
  const depth = oneCellDepth(selection);
  if (depth > 0) return inCellClipped(editor, view, depth);
  if (!holdsTable(selection)) return null;
  const { clipboardHTML, externalHTML } = selectedFragmentToHTML(view, editor);
  const blocks = fragmentToBlocks(selection.content().content as never) as never[];
  return { internal: clipboardHTML, external: externalHTML, plain: blocksMarkdown(editor, blocks) };
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
