// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A drag within the body put as its paste at the drop point (inner#1351
 * design §5.4.1), where ProseMirror's own drop would land it otherwise: a
 * table, or cells selected in one, into a table cell (A12, A14), and more
 * than one line of words into a block that takes only words, a code block or
 * a stored (legacy) table's cell (A7). Any other drag within the body is
 * ProseMirror's own drop.
 *
 * What is put is the drag's own content, which ProseMirror took at dragstart
 * and ran through `transformPasted`: a move keeps its comments and a copy
 * drops them (`document-comment-paste.ts`). It is read the way its copy is,
 * through the clipboard HTML ProseMirror writes for it, so a stored table
 * reads as ours; a table filling cells is that HTML parsed back into the
 * body's own nodes, its comments with it.
 */

import { DOMParser, type Node as PMNode, type Slice } from '@tiptap/pm/model';
import { cellAround } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';

import { t } from '@breatic/shared';

import { toast } from '@web/lib/toast';
import { carriesTable } from '@web/spaces/document/document-drag-move';
import { readTransfer, type BlockReader } from '@web/spaces/document/document-paste-read';
import { onlyTable, putContent, selectPlaced, textOnlyAt } from '@web/spaces/document/document-put';
import { DOC_TABLE } from '@web/spaces/document/document-table-nodes';

/** The editor a drop is put by. */
type Editor = Parameters<typeof putContent>[0] & BlockReader;

/**
 * Whether dragged content is words inside one line, which any line takes as
 * ProseMirror puts them.
 * @param slice - The dragged content.
 * @returns True for words of one line.
 */
function wordsOfOneLine(slice: Slice): boolean {
  let content = slice.content;
  let open = slice.openStart;
  while (content.childCount === 1 && !content.firstChild!.isTextblock && open > 0) {
    content = content.firstChild!.content;
    open -= 1;
  }
  return open > 0 && content.childCount === 1 && content.firstChild!.isTextblock;
}

/**
 * The one table dragged content holds, as the body's own node: its table, or
 * the rows of selected cells in a table of their own.
 * @param html - The content's clipboard HTML.
 * @param view - The view.
 * @returns The table, or undefined when it holds none.
 */
function draggedTable(html: string, view: EditorView): PMNode | undefined {
  const { schema } = view.state;
  const dom = document.createElement('div');
  dom.innerHTML = html;
  const parsed = DOMParser.fromSchema(schema).parseSlice(dom);
  let table: PMNode | undefined;
  const rows: PMNode[] = [];
  parsed.content.descendants((node) => {
    if (table !== undefined) return false;
    if (node.type.name === DOC_TABLE) table = node;
    else if (node.type.name === 'docTableRow') rows.push(node);
    else return true;
    return false;
  });
  return table ?? (rows.length > 0 ? schema.nodes[DOC_TABLE]!.create(null, rows) : undefined);
}

/**
 * Puts a drag within the body as its paste at the drop point, where its paste
 * lands otherwise than ProseMirror's own drop.
 * @param editor - The editor.
 * @param view - The view.
 * @param event - The drop.
 * @param slice - The dragged content, as ProseMirror hands it to `handleDrop`.
 * @param moved - Whether the drop moves it, as ProseMirror reads the keys at the drop.
 * @returns True when the drop was put here.
 */
export function dropAsPaste(editor: Editor, view: EditorView, event: DragEvent, slice: Slice, moved: boolean): boolean {
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
  if (at === undefined) return false;
  const $at = view.state.doc.resolve(at);
  const intoCell = cellAround($at) !== null && carriesTable(slice.content);
  if (!intoCell && (textOnlyAt($at) === null || wordsOfOneLine(slice))) return false;
  const html = view.serializeForClipboard(slice).dom.innerHTML;
  const read = readTransfer(editor, { types: ['blocknote/html'], getData: () => html }, () => true);
  if (intoCell && onlyTable(read.blocks) === null) {
    toast.warning(t('spaces.document.paste.unsupportedInCell'));
    return true;
  }
  let point = at;
  if (moved) {
    const tr = view.state.tr.deleteSelection();
    point = tr.mapping.map(at);
    view.dispatch(tr);
  }
  const table = intoCell ? draggedTable(html, view) : undefined;
  const placed = putContent(editor, { ...read, table }, { wordsIntoTarget: true, judge: (props) => props, dropAt: point });
  if (placed !== null) selectPlaced(view, placed);
  return true;
}
