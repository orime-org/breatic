// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
 * A stored (legacy) table copies by the same rules (inner#1351 design §5.4.3
 * "stored tables"): words in one of its cells as those words, a selection
 * across its cells, or leaving or entering it, with the whole table, and a
 * cut and a drag's move take away what the copy carries. Temporary, with #1362's conversion of
 * stored tables: it goes once no stored document holds a `table` node.
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
import { Fragment, Slice, type ResolvedPos } from '@tiptap/pm/model';
import type { Selection} from '@tiptap/pm/state';
import { AllSelection, NodeSelection, Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { CellSelection, deleteCellSelection } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';

import { blocksMarkdown } from '@web/spaces/document/document-table-markdown';
import { bodyEdgeBetween } from '@web/spaces/document/document-body-edge-selection';
import { heldRange, replaceHeld, type HeldTables } from '@web/spaces/document/document-table-leave-selection';
import { cellDepthOf, DOC_TABLE, tableAround, type TableAt } from '@web/spaces/document/document-table-nodes';

/** The editor, as far as copying reads it. */
type CopyEditor = BlockNoteEditor<never, never, never>;

/** What goes on the clipboard. */
export interface Clipped {
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

/** Blocks whose copy writes its own slice. */
type SlicedBlocks = ClippedBlocks & { readonly slice: Slice };

/**
 * Selected cells, as a table of those cells.
 * @param view - The editor view.
 * @param selection - The cell selection.
 * @returns The blocks and the slice.
 */
export function cellsBlocks(view: EditorView, selection: CellSelection): SlicedBlocks {
  const slice = selection.content();
  const first = slice.content.firstChild;
  // prosemirror-tables hands the whole table when every cell is selected, and
  // its rows otherwise.
  const table =
    first?.type.name === DOC_TABLE ? first : view.state.schema.nodes[DOC_TABLE].create(null, slice.content);
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
  // The cell's blocks go back into a block group, as the body's own copy
  // starts, so each end opens as deep as the same lines copied in the body.
  const group = view.state.schema.nodes['blockGroup'].create(null, content);
  const slice = new Slice(Fragment.from(group), Math.max(0, whole.openStart - depth) + 1, Math.max(0, whole.openEnd - depth) + 1);
  return { blocks: fragmentToBlocks(content as never) as never[], slice };
}

/**
 * The stored (legacy) table a position is in.
 * @param $at - The position.
 * @returns It, or null outside any.
 */
function storedAround($at: ResolvedPos): TableAt | null {
  for (let d = 1; d <= $at.depth; d += 1) if ($at.node(d).type.name === 'table') return { pos: $at.before(d), node: $at.node(d) };
  return null;
}

/**
 * The tables at the ends of a selection reaching into a stored (legacy)
 * table, stored or not, taken whole as a selection leaving a table of blocks
 * takes them (`heldTables`): a selection across a stored table's cells takes
 * it whole. Words in one cell are the selection's own; selections of cells,
 * of a node and of everything are their own.
 * @param selection - The selection.
 * @returns The table at each end, or null when the selection reaches no stored table or stays in one of its cells.
 */
function storedEnds(selection: Selection): HeldTables | null {
  if (selection.empty || selection instanceof CellSelection || selection instanceof NodeSelection || selection instanceof AllSelection) return null;
  const { $from, $to } = selection;
  const from = storedAround($from);
  const to = storedAround($to);
  if ($from.sameParent($to) || (from === null && to === null)) return null;
  return { from: from ?? tableAround($from), to: to ?? tableAround($to) };
}

/**
 * What a selection reaching into a stored (legacy) table acts on: its range
 * widened over the table at each end, stored or not (`heldRange`). A stored
 * table's range starts with its block, so the copy carries the block it
 * stands in, and ends with the table, the lines nested under it left out.
 * @param selection - The selection.
 * @returns The range, or null when the selection reaches no stored table or stays in one of its cells.
 */
export function storedTableRange(selection: Selection): { from: number; to: number } | null {
  const ends = storedEnds(selection);
  const range = heldRange(selection, ends);
  return range !== null && ends?.from?.node.type.name === 'table' ? { ...range, from: ends.from.pos - 1 } : range;
}

/**
 * Takes away what a selection reaching into a stored (legacy) table acts on,
 * as a selection leaving a table of blocks is taken away (`replaceHeld`): the
 * table at each end turns into an empty line, a stored one into the line of
 * its block, which keeps the lines nested under it.
 * @param selection - The selection, on the transaction's document.
 * @param tr - The transaction.
 * @returns Whether the selection reached a stored table; false leaves it to the caller.
 */
export function replaceStoredHeld(selection: Selection, tr: Transaction): boolean {
  const ends = storedEnds(selection);
  return ends !== null && replaceHeld(selection, tr, undefined, bodyEdgeBetween, ends);
}

/**
 * A selection reaching into a stored (legacy) table: the words of one of its
 * cells as a line of those words, opened into the line at both ends, or the
 * range it acts on (`storedTableRange`).
 * @param view - The editor view.
 * @returns The blocks and the slice, or null when the selection reaches no stored table.
 */
function inStoredTable(view: EditorView): ClippedBlocks | null {
  const { selection, schema, doc } = view.state;
  const { $from, $to } = selection;
  if ($from.sameParent($to) && storedAround($from) !== null) {
    const words = $from.parent.content.cut($from.parentOffset, $to.parentOffset);
    const line = schema.nodes['blockContainer'].create(null, schema.nodes['paragraph'].create(null, words));
    const group = schema.nodes['blockGroup'].create(null, line);
    return { blocks: fragmentToBlocks(group.content as never) as never[], slice: new Slice(Fragment.from(group), 3, 3) };
  }
  const range = storedTableRange(selection);
  if (range === null) return null;
  return { blocks: fragmentToBlocks(doc.slice(range.from, range.to, true).content as never) as never[], slice: doc.slice(range.from, range.to) };
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
  // A node selected in a cell (a picture, a video) is BlockNote's to copy, as
  // in the body: its content carries the node alone, not the levels above.
  if (selection instanceof NodeSelection) return null;
  const stored = inStoredTable(view);
  if (stored !== null) return stored;
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
  if (picked.slice === null) {
    const { clipboardHTML, externalHTML } = selectedFragmentToHTML(view, editor);
    return { internal: clipboardHTML, external: externalHTML, plain: blocksMarkdown(editor, picked.blocks) };
  }
  return clippedOf(editor, view, { blocks: picked.blocks, slice: picked.slice });
}

/**
 * What a copy of some blocks and their slice puts on the clipboard.
 * @param editor - The editor.
 * @param view - The editor view.
 * @param picked - The blocks and the slice.
 * @returns The clipboard.
 */
function clippedOf(editor: CopyEditor, view: EditorView, picked: SlicedBlocks): Clipped {
  return {
    internal: internalHTML(view, picked.slice),
    external: editor.blocksToHTMLLossy(picked.blocks),
    plain: blocksMarkdown(editor, picked.blocks),
  };
}

/**
 * What a copy of some cells puts on the clipboard, the same as Cmd+C with
 * those cells selected.
 * @param editor - The editor.
 * @param view - The editor view.
 * @param cells - The cells.
 * @returns The clipboard.
 */
export function cellsClipped(editor: CopyEditor, view: EditorView, cells: CellSelection): Clipped {
  return clippedOf(editor, view, cellsBlocks(view, cells));
}

/**
 * Writes what a copy carries onto the clipboard.
 * @param event - The copy or cut.
 * @param clipped - What it carries.
 */
export function writeClipped(event: ClipboardEvent, clipped: Clipped): void {
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
        // A drag of the selection carries what its copy does (words in a cell
        // without the table around them, a range leaving a table with the
        // table): ProseMirror keeps this slice at dragstart (`view.dragging`),
        // before the selection can move (Outline `TableCell.ts` clips the same).
        transformCopied: (slice, view) =>
          (slice.eq(view.state.selection.content()) ? tableClippedBlocks(view)?.slice : null) ?? slice,
        handleDOMEvents: {
          copy: (view, event) => {
            const clipped = tableClipped(editor as unknown as CopyEditor, view);
            if (clipped === null) return false;
            writeClipped(event, clipped);
            return true;
          },
          cut: (view, event) => {
            const clipped = tableClipped(editor as unknown as CopyEditor, view);
            if (clipped === null) return false;
            writeClipped(event, clipped);
            if (!view.editable) return true;
            const tr = view.state.tr;
            if (view.state.selection instanceof CellSelection) {
              deleteCellSelection(view.state, view.dispatch);
            } else {
              if (!replaceStoredHeld(view.state.selection, tr)) tr.deleteSelection();
              view.dispatch(tr);
            }
            return true;
          },
        },
      },
    }),
  ],
}));
