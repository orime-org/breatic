// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Where pasted or dropped content goes (inner#1351 + inner#1390 design
 * §5.4.3): the target settled from the selection first, then one set of
 * placement rules for web content, the body's own content, canvas nodes and
 * files alike, and the caret after what was put. Content arrives as a slice,
 * is transformed once on its target and read as lines (`rowsOf`); one line of
 * words goes in by ProseMirror's own paste, everything else by the placement
 * here. In a table cell (§5.4.7) one table fills the cells from the target
 * cell and any other content goes into the cell.
 */

import { blockToNode, type BlockNoteEditor } from '@blocknote/core';
import { Fragment, Slice, type Node as PMNode, type ResolvedPos, type Schema } from '@tiptap/pm/model';
import { NodeSelection, TextSelection, type Transaction } from '@tiptap/pm/state';
import { __insertCells as insertCells, __pastedCells as pastedCells, cellAround, CellSelection, selectedRect } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';

import { newId, t } from '@breatic/shared';

import { toast } from '@web/lib/toast';

import { landingSlice, withoutRowIds } from '@web/spaces/document/document-comment-paste';
import { gapAtDrop, insertAtGapTr, quotedBeside } from '@web/spaces/document/document-file-input';
import { QUOTED } from '@web/spaces/document/document-list-block';
import { isMediaBlockType } from '@web/spaces/document/document-media-types';
import type { Read, ReadBlock } from '@web/spaces/document/document-paste-read';
import { isWordsLine, rowsOf, WORDS, type Rows } from '@web/spaces/document/document-paste-slice';
import { DOC_TABLE, isTableCell, keepTablesWhole, squareSelectedTable } from '@web/spaces/document/document-table-nodes';
import { heldTables, swapHeldTables } from '@web/spaces/document/document-table-leave-selection';
import { HOLD_PRE_EDIT_SELECTION } from '@web/spaces/document/document-undo-selection';

/** How a medium lands: its props as they go in, or null when it is left out. */
export type JudgeMedium = (props: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>> | null;

/** What a placement needs besides the content. */
export interface PutOptions {
  /**
   * Whether a code block or a stored (legacy) table cell takes the words while
   * the media go beside it (a paste, a drop, canvas words alone); otherwise
   * the whole content goes beside it (canvas content with media, files).
   */
  readonly wordsIntoTarget: boolean;
  /** Judges every medium put in; one left out is counted by whoever judged it. */
  readonly judge: JudgeMedium;
  /** Told how many media reading left out, unless a code block took the plain text as it is. */
  readonly leaveOut?: (count: number) => void;
  /**
   * A drop's point (§5.4.1): the content goes where a paste with the caret
   * there puts it, in a line opened for it when the point is off a line of
   * words. Nothing moves until something is sure to go in.
   */
  readonly dropAt?: number;
  /**
   * Whether one line of words goes in by ProseMirror's own paste, its paste
   * handlers seeing it (a paste, a drop); content built here (canvas, files)
   * goes in by a dispatch of its own.
   */
  readonly byPaste: boolean;
  /** Whether a drag within the body already settled the content's comments and row ids at the drop point. */
  readonly landed?: boolean;
}

/** Where content landed, for a drop to select. */
export type Placed =
  | { readonly kind: 'range'; readonly from: number; readonly to: number }
  | { readonly kind: 'cells'; readonly anchor: number; readonly head: number };

/** The editor the placement works through. */
type Editor = Pick<BlockNoteEditor<never, never, never>, 'pasteText'> & {
  readonly prosemirrorView: EditorView | undefined | null;
};

/**
 * Blocks read or built elsewhere as a closed slice.
 * @param blocks - The blocks.
 * @param schema - The body's schema.
 * @returns The slice.
 */
function blocksSlice(blocks: readonly ReadBlock[], schema: Schema): Slice {
  return new Slice(Fragment.from(blocks.map((block) => blockToNode(block as never, schema))), 0, 0);
}

/**
 * A slice transformed on its target (§5.4.3 "the slice transformed once on
 * the target"): a paste or a drop from outside the body arrives without its
 * comments and its row ids, as UniqueID gives a paste new ones; a drag within
 * the body has settled both at the drop point; tables stay whole.
 * @param view - The view, its selection on the target.
 * @param slice - The slice.
 * @param landed - Whether a drag within the body settled comments and row ids.
 * @returns The slice.
 */
function onTarget(view: EditorView, slice: Slice, landed: boolean): Slice {
  return keepTablesWhole(landed ? slice : withoutRowIds(landingSlice(slice, view, false)), view);
}

/**
 * Nodes with every medium judged: those left out go, the lines nested under
 * them taking their place, and a cell left with nothing gets an empty line.
 * @param nodes - The nodes.
 * @param judge - The judge.
 * @param schema - The body's schema.
 * @returns The nodes.
 */
function judged(nodes: readonly PMNode[], judge: JudgeMedium, schema: Schema): PMNode[] {
  return nodes.flatMap((node): PMNode[] => {
    const own = node.type.name === 'blockContainer' ? node.firstChild! : null;
    if (own !== null && isMediaBlockType(own.type.name)) {
      const props = judge(own.attrs);
      const nested = node.lastChild?.type.name === 'blockGroup' ? judged(node.lastChild.children, judge, schema) : [];
      if (props === null) return nested;
      const media = own.type.create({ ...own.attrs, ...props }, own.content, own.marks);
      return [node.type.create(node.attrs, [media, ...(nested.length > 0 ? [node.lastChild!.copy(Fragment.from(nested))] : [])], node.marks)];
    }
    if (node.isTextblock || node.isLeaf) return [node];
    const children = judged(node.children, judge, schema);
    // A nested group left with nothing goes with what it held.
    if (node.type.name === 'blockGroup' && children.length === 0) return [];
    if (isTableCell(node) && children.length === 0) children.push(schema.nodes['blockContainer']!.create(null, schema.nodes['paragraph']!.create()));
    return [node.copy(Fragment.from(children))];
  });
}

/**
 * The last line of a top-level block in reading order: itself, or the last of
 * its nested lines, all the way down. A table is a block of its own.
 * @param node - The block.
 * @returns The line read last.
 */
function lastInReading(node: PMNode): PMNode {
  if (node.type.name !== 'blockContainer' || node.lastChild?.type.name !== 'blockGroup') return node;
  return lastInReading(node.lastChild.lastChild!);
}

/**
 * The type of a top-level block's own content: its line's type, or the block's.
 * @param node - The block.
 * @returns The type's name.
 */
function typeOf(node: PMNode): string {
  return node.type.name === 'blockContainer' ? node.firstChild!.type.name : node.type.name;
}

/**
 * The row id a block put in carries: a moved line's own; content from
 * anywhere else arrives with none.
 * @param node - The block.
 * @returns The id, or null for none.
 */
function carriedId(node: PMNode): string | null {
  const id = node.attrs['id'] as unknown;
  return typeof id === 'string' && id !== '' && id !== 'null' ? id : null;
}

/**
 * A line's words, each line break as one.
 * @param textblock - The line's own content.
 * @returns The words.
 */
function wordsIn(textblock: PMNode): string {
  return textblock.textBetween(0, textblock.content.size, '', (leaf) => (leaf.type.name === 'hardBreak' ? '\n' : ''));
}

/**
 * Blocks quoted, all they hold too (nested lines, a table's cells): the
 * quote on every block that takes one.
 * @param nodes - The blocks.
 * @returns They, quoted.
 */
function quoted(nodes: readonly PMNode[]): PMNode[] {
  return nodes.map((node) => {
    const attrs = QUOTED in node.attrs ? { ...node.attrs, [QUOTED]: true } : node.attrs;
    if (node.isTextblock || node.isLeaf) return node.type.create(attrs, node.content, node.marks);
    const children: PMNode[] = [];
    node.forEach((child) => children.push(child));
    return node.type.create(attrs, Fragment.from(quoted(children)), node.marks);
  });
}

/**
 * Whether blocks put anything in: a block that is not a line of words, or any
 * words besides a last line break, nested ones too. Empty lines alone, such as
 * what is left of a line whose only medium did not land, put nothing.
 * @param rows - The blocks.
 * @param parsed - Whether they were parsed from clipboard HTML, which dropped each last line break already.
 * @returns True when they do.
 */
export function holdsContent(rows: readonly PMNode[], parsed: boolean): boolean {
  return rows.some((node) => {
    if (node.type.name !== 'blockContainer') return true;
    const own = node.firstChild!;
    // A line's last line break pastes as nothing, as ProseMirror's clipboard read drops it.
    if (!own.isTextblock || (parsed ? wordsIn(own) : wordsIn(own).replace(/\n$/, '')) !== '') return true;
    return node.lastChild?.type.name === 'blockGroup' && holdsContent(node.lastChild.children, parsed);
  });
}

/**
 * Whether content holds a node of a type, at any depth.
 * @param content - The content.
 * @param name - The type's name.
 * @returns True when it does.
 */
export function holdsNode(content: Fragment, name: string): boolean {
  let found = false;
  content.descendants((node) => {
    if (node.type.name === name) found = true;
    return !found;
  });
  return found;
}

/**
 * The one table alone, ignoring lines around it that show no words: a line
 * break or a no-break space reads as text but leaves the line blank.
 * @param rows - The blocks.
 * @returns Its table, or null for mixed content.
 */
function onlyTable(rows: readonly PMNode[]): PMNode | null {
  const kept = rows.filter((node) => !(node.type.name === 'blockContainer' && typeOf(node) === 'paragraph' && node.childCount === 1 && node.textContent.trim() === ''));
  return kept.length === 1 && kept[0]!.type.name === DOC_TABLE ? kept[0]! : null;
}

/**
 * Whether content is refused in a table cell (A14): it holds a table, and is
 * not one table alone.
 * @param inCell - Whether its target is in a table cell.
 * @param rows - The content's blocks.
 * @returns True when it is refused there.
 */
export function refusedInCell(inCell: boolean, rows: readonly PMNode[]): boolean {
  return inCell && holdsNode(Fragment.from(rows), DOC_TABLE) && onlyTable(rows) === null;
}

/**
 * Whether content is one line of words alone: one line of words, both ends
 * joining (§5.4.3 "one line of words"). A copy that starts at a line's end or
 * ends at one's start carries a line of no words, and goes by the placement.
 * @param rows - The content's lines.
 * @returns True for one line of words.
 */
function isOneLine(rows: Rows): boolean {
  return rows.rows.length === 1 && isWordsLine(rows.rows[0]) && rows.start === 'joins' && rows.end === 'joins';
}

/**
 * Lines as a slice opened into their first and last line's words, the shape
 * ProseMirror joins with the words around the caret.
 * @param schema - The body's schema.
 * @param rows - The lines.
 * @returns The slice.
 */
function openLines(schema: Schema, rows: readonly PMNode[]): Slice {
  const group = schema.nodes['blockGroup']!.create(null, rows);
  return new Slice(Fragment.from(group), isWordsLine(rows[0]) ? 3 : 1, isWordsLine(rows[rows.length - 1]) ? 3 : 1);
}

/**
 * Puts a slice in at the selection the way ProseMirror's own paste puts what
 * it parsed (`doPaste`): its paste transforms run on the target, its paste
 * handlers see the slice (a web address over selected words becomes a link),
 * then the selection is replaced. The slice is the content as read, with no
 * second pass through HTML.
 * @param view - The view.
 * @param slice - The slice.
 * @param handlers - Whether the paste handlers and paste rules see it: a paste
 *   or a drop. Content built here (canvas, files) is put as it is.
 */
function pasteSlice(view: EditorView, slice: Slice, handlers: boolean): void {
  let pasted = slice;
  view.someProp('transformPasted', (transform) => {
    pasted = transform(pasted, view, false);
  });
  if (!handlers) {
    view.dispatch(view.state.tr.replaceSelection(pasted).scrollIntoView());
    return;
  }
  if (view.someProp('handlePaste', (handle) => handle(view, new ClipboardEvent('paste'), pasted))) return;
  view.dispatch(view.state.tr.replaceSelection(pasted).scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'));
}

/**
 * Puts one line of words in at the selection, as words joining the line
 * there; its paste handlers see it for a paste or a drop, not for content
 * built here (canvas, files).
 * @param view - The view.
 * @param line - The line.
 * @param byPaste - Whether it came by a paste or a drop.
 * @returns Where the words landed.
 */
function putWords(view: EditorView, line: PMNode, byPaste: boolean): Placed {
  const { from, $from, $to } = view.state.selection;
  const target = lineAt($from);
  let put = line;
  // A line left with no words of its own (empty, or its words all selected)
  // keeps its type and quote and gives them to the words (§5.4.3):
  // ProseMirror would put the pasted line's in their place.
  const emptied = $from.parent.isTextblock && $from.sameParent($to) && $from.parentOffset === 0 && $to.parentOffset === $from.parent.content.size;
  if (target !== null && emptied && $from.parent.type.name !== 'paragraph') put = retyped(put, target.node);
  if (target?.node.firstChild?.attrs[QUOTED] === true) put = quoted([put])[0]!;
  pasteSlice(view, openLines(view.state.schema, [put]), byPaste);
  return { kind: 'range', from, to: view.state.selection.head };
}

/**
 * The block container a position is in.
 * @param $at - The position.
 * @returns The container and where it starts, or null outside any block.
 */
function lineAt($at: ResolvedPos): { node: PMNode; pos: number } | null {
  for (let depth = $at.depth; depth > 0; depth -= 1) {
    if ($at.node(depth).type.name === 'blockContainer') return { node: $at.node(depth), pos: $at.before(depth) };
  }
  return null;
}

/**
 * The legacy table or code block a position is in, as its block container.
 * @param $at - The position.
 * @returns It, or null when the position is in neither.
 */
function textOnlyAt($at: ResolvedPos): { node: PMNode; pos: number } | null {
  for (let depth = $at.depth; depth > 1; depth -= 1) {
    const name = $at.node(depth).type.name;
    if (name === 'table' || name === 'codeBlock') return { node: $at.node(depth - 1), pos: $at.before(depth - 1) };
  }
  return null;
}

/**
 * Every medium among blocks in reading order, nested lines and table cells
 * included, and the blocks without them, a medium's nested lines taking its
 * place: what goes beside a block that takes only words, and what goes inside it.
 * @param rows - The blocks.
 * @returns The media and the rest.
 */
function takeMedia(rows: readonly PMNode[]): { beside: PMNode[]; inside: PMNode[] } {
  const media: PMNode[] = [];
  /**
   * The nodes without their media.
   * @param list - The nodes.
   * @returns The rest.
   */
  const strip = (list: readonly PMNode[]): PMNode[] =>
    list.flatMap((node): PMNode[] => {
      if (node.isTextblock || node.isLeaf) return [node];
      const own = node.type.name === 'blockContainer' ? node.firstChild! : null;
      if (own !== null && isMediaBlockType(own.type.name)) {
        media.push(node.type.create(node.attrs, own));
        return node.lastChild?.type.name === 'blockGroup' ? strip(node.lastChild.children) : [];
      }
      return [node.copy(Fragment.from(strip(node.children)))];
    });
  const inside = strip(rows);
  return { beside: media, inside };
}

/**
 * The words of blocks, one line each, nested lines too, a table's cells
 * split by tabs and its rows by line breaks.
 * @param rows - The blocks.
 * @returns The text.
 */
function wordsOf(rows: readonly PMNode[]): string {
  return rows.map((node) => {
    if (node.type.name === DOC_TABLE) {
      return node.children.map((row) => row.children.map((cell) => wordsOf(cell.children)).join('\t')).join('\n');
    }
    const nested = node.lastChild?.type.name === 'blockGroup' ? node.lastChild.children : [];
    return [node.firstChild!.isTextblock ? wordsIn(node.firstChild!) : '', ...nested.map((child) => wordsOf([child]))].join('\n');
  }).join('\n');
}

/**
 * The block container with an id.
 * @param doc - The document.
 * @param id - The id.
 * @returns It and where it starts, or null when it is gone.
 */
function containerById(doc: PMNode, id: string): { node: PMNode; pos: number } | null {
  let found: { node: PMNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'blockContainer' && node.attrs['id'] === id) found = { node, pos };
    return found === null;
  });
  return found;
}

/**
 * Puts the caret at the start of the line that follows a position between
 * blocks in reading order, nested lines first and leaving nested groups
 * upward, when that line holds words; else in an empty line opened there,
 * quoted as asked (Lexical's `insertNodes` leaves the caret after the last
 * block it puts; ProseMirror has no caret between blocks, so a line holds it).
 * @param tr - The transaction.
 * @param slot - The position right after the last block put.
 * @param isQuoted - Whether an opened line is quoted.
 */
function caretFrom(tr: Transaction, slot: number, isQuoted: boolean): void {
  let $next = tr.doc.resolve(slot);
  // Past the end of a nested group, the line that follows is the next one after its parent.
  while ($next.nodeAfter === null && $next.depth > 1 && !isTableCell($next.parent)) $next = tr.doc.resolve($next.after($next.depth - 1));
  const after = $next.nodeAfter;
  if (after?.type.name === 'blockContainer' && after.firstChild?.isTextblock === true) {
    tr.setSelection(TextSelection.create(tr.doc, $next.pos + 2));
    return;
  }
  tr.insert(slot, blockToNode({ id: newId(), type: 'paragraph', props: { [QUOTED]: isQuoted } } as never, tr.doc.type.schema));
  tr.setSelection(TextSelection.create(tr.doc, slot + 2));
}

/**
 * Puts the caret after content laid out from `start` (§5.4.3): after its
 * last line in reading order when that holds words, else at the start of
 * the line that follows it (`caretFrom`). A line's own nested blocks handed
 * to the last container sit right after its content, so they follow first.
 * @param tr - The transaction.
 * @param nodes - The content's own containers, before a line hands its nested blocks to the last of them.
 * @param start - Where they start.
 */
function finishCaret(tr: Transaction, nodes: readonly PMNode[], start: number): void {
  let pos = start + nodes.slice(0, -1).reduce((sum, node) => sum + node.nodeSize, 0);
  let last = nodes[nodes.length - 1]!;
  while (last.type.name === 'blockContainer' && last.childCount > 1) {
    const group = last.lastChild!;
    pos += 2 + last.firstChild!.nodeSize + group.content.size - group.lastChild!.nodeSize;
    last = group.lastChild!;
  }
  const own = last.type.name === DOC_TABLE ? null : last.firstChild!;
  if (own?.isTextblock === true) tr.setSelection(TextSelection.create(tr.doc, pos + 2 + own.content.size));
  else caretFrom(tr, pos + last.nodeSize, (own ?? last).attrs[QUOTED] === true);
}

/**
 * A line with other words, keeping the line's type, attributes and nested blocks.
 * @param line - The line.
 * @param words - Its words.
 * @param id - Its id.
 * @param nested - Whether its nested blocks stay with it.
 * @returns The line.
 */
function lineWith(line: PMNode, words: Fragment, id: string, nested: boolean): PMNode {
  const content = line.firstChild!;
  const group = nested && line.childCount > 1 ? [line.lastChild!] : [];
  return line.type.create({ ...line.attrs, id }, [content.type.create(content.attrs, words, content.marks), ...group]);
}

/**
 * A container of words retyped as a line: its words, the line's type and attributes.
 * @param container - The container.
 * @param line - The line.
 * @returns The container.
 */
function retyped(container: PMNode, line: PMNode): PMNode {
  const content = line.firstChild!;
  return container.type.create(container.attrs, [
    content.type.create(content.attrs, container.firstChild!.content, content.marks),
    ...(container.childCount > 1 ? [container.lastChild!] : []),
  ]);
}

/**
 * Hands a line's nested blocks to the last container, when it has any.
 * @param nodes - The containers.
 * @param line - The line.
 * @returns The containers.
 */
function nestLast(nodes: PMNode[], line: PMNode): PMNode[] {
  if (line.childCount < 2 || nodes.length === 0) return nodes;
  const last = nodes[nodes.length - 1]!;
  if (last.type.name !== 'blockContainer') return [...nodes, ...line.lastChild!.children];
  const group = last.childCount > 1 ? last.lastChild!.content.append(line.lastChild!.content) : line.lastChild!.content;
  const content = Fragment.from([last.firstChild!, line.lastChild!.type.create(null, group)]);
  return [...nodes.slice(0, -1), last.type.create(last.attrs, content)];
}

/**
 * Puts content in a block that takes only words, a code block or a stored
 * (legacy) table, line by line (§5.4.3 "a code block taking content"): the
 * words go in first (a code block takes each line's words as plain text, a
 * stored table's cell takes the lines by ProseMirror's own paste, whose
 * transforms read them into its words), the media beside the block afterwards, found again by
 * its id. An empty code block counts as an empty line: the media go above it
 * and the caret stays in it.
 * @param editor - The editor.
 * @param rows - The content's lines, their media judged, transformed on the target.
 * @param pasted - The same lines as ProseMirror's own paste takes them, untransformed.
 * @param target - The table's or the code block's container.
 * @param target.node - The container.
 * @param target.pos - Where it starts.
 * @param options - The placement's options: whether the words go into the
 *   block or the whole content beside it, and whether the paste handlers see them.
 * @returns The words put in the block, else the last block put beside it.
 */
function putInTextOnly(editor: Editor, rows: readonly PMNode[], pasted: readonly PMNode[], target: { node: PMNode; pos: number }, options: PutOptions): Placed {
  const view = editor.prosemirrorView!;
  const id = target.node.attrs['id'] as string;
  const code = target.node.firstChild!.type.name === 'codeBlock';
  const beside = options.wordsIntoTarget ? takeMedia(rows).beside : [...rows];
  const inside = options.wordsIntoTarget ? takeMedia(pasted).inside : [];
  const from = view.state.selection.from;
  if (inside.length > 0) {
    if (code) editor.pasteText(wordsOf(inside));
    else pasteSlice(view, openLines(view.state.schema, inside), options.byPaste);
  }
  const after = view.state.selection;
  const words: Placed | null = inside.length > 0 ? { kind: 'range', from: Math.min(from, after.head), to: after.head } : null;
  const found = beside.length === 0 ? null : containerById(view.state.doc, id);
  if (found === null) return words ?? { kind: 'range', from, to: from };
  const blockContent = found.node.firstChild!;
  const nodes = blockContent.attrs[QUOTED] === true ? quoted(beside) : beside;
  const emptyCode = blockContent.type.name === 'codeBlock' && blockContent.content.size === 0;
  const at = emptyCode ? found.pos : found.pos + found.node.nodeSize;
  const tr = view.state.tr.insert(at, nodes);
  const size = nodes.reduce((sum, node) => sum + node.nodeSize, 0);
  if (emptyCode) tr.setSelection(TextSelection.create(tr.doc, at + size + 2));
  else finishCaret(tr, nodes, at);
  view.dispatch(tr.scrollIntoView());
  if (words !== null) return words;
  return { kind: 'range', from: at + size - nodes[nodes.length - 1]!.nodeSize, to: at + size };
}

/**
 * Where a cell selection's anchor and head cells are.
 * @param selection - The cell selection.
 * @returns It, as placed.
 */
function cellsOf(selection: CellSelection): Placed {
  return { kind: 'cells', anchor: selection.$anchorCell.pos, head: selection.$headCell.pos };
}

/**
 * Opens the way for a drop (§5.4.1): an empty line in the gap a point off a
 * line of words lands in, quoted as the line beside it, or the caret at the
 * point, the selection from before it kept for undo.
 * @param view - The view.
 * @param $drop - The drop's point.
 * @param opened - Whether the point is off a line of words.
 */
function aim(view: EditorView, $drop: ResolvedPos, opened: boolean): void {
  view.focus();
  if (!opened) {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, $drop.pos)).setMeta(HOLD_PRE_EDIT_SELECTION, true));
    return;
  }
  const gap = gapAtDrop(view.state.doc, $drop.pos);
  const tr = insertAtGapTr(view.state, gap, [{ type: 'paragraph' }]);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, gap + 2)));
}

/**
 * Puts one source grid once from the target cell, growing the table as needed.
 * @param view - The editor view, with its target cell selected.
 * @param table - The source table.
 * @returns The rectangle written.
 */
function putTableInCells(view: EditorView, table: PMNode): Placed | null {
  squareSelectedTable(view);
  const rect = selectedRect(view.state);
  const cells = pastedCells(new Slice(Fragment.from(table), 0, 0));
  if (cells === null) return null;
  insertCells(view.state, (tr) => view.dispatch(tr.scrollIntoView()), rect.tableStart, rect, cells);
  return cellsOf(view.state.selection as CellSelection);
}

/**
 * Repeats ordinary blocks through a cell selection, retaining the cells' own
 * types and attributes. Each copy has its own block ids and the same upload ids.
 * @param view - The view with a cell selection.
 * @param rows - The content to put in each selected cell.
 * @returns The content written to the top-left cell.
 */
function putBlocksInCells(view: EditorView, rows: readonly PMNode[]): Placed {
  squareSelectedTable(view);
  const selection = view.state.selection as CellSelection;
  const rect = selectedRect(view.state);
  const top = rect.tableStart + rect.map.positionAt(rect.top, rect.left, rect.table);
  const cells: { node: PMNode; pos: number }[] = [];
  selection.forEachCell((node, pos) => cells.push({ node, pos }));
  // The rows arrive without ids, so the editor gives every copy ids of its own.
  const blocks = [...rows];
  const tr = view.state.tr;
  for (const { node, pos } of cells.sort((a, b) => b.pos - a.pos)) tr.replaceWith(pos + 1, pos + node.nodeSize - 1, blocks);
  finishCaret(tr, blocks, top + 1);
  view.dispatch(tr.scrollIntoView());
  return { kind: 'range', from: top + 1, to: top + 1 + blocks.reduce((size, node) => size + node.nodeSize, 0) };
}

/**
 * Puts content at the selection, or at a drop's point (§5.4.3). In a code
 * block plain text goes in as it is; otherwise the content is transformed on
 * its target, read as lines, every medium judged once, and content that puts
 * nothing in changes nothing. Then the selection settles the target: in a
 * table cell or over selected cells, one table fills the cells from the
 * target cell and any other content goes into the cell (§5.4.7); one line of
 * words goes in as words at the selection; a selected block is replaced in
 * place; any other content is put after a text selection is deleted and the
 * caret's line judged.
 * @param editor - The editor.
 * @param content - The content, its media not judged yet.
 * @param options - The placement's options.
 * @returns Where the content landed, or null when nothing went in.
 */
export function putContent(editor: Editor, content: Read, options: PutOptions): Placed | null {
  const view = editor.prosemirrorView;
  if (view === undefined || view === null) return null;
  const { doc, selection, schema } = view.state;
  const $drop = options.dropAt === undefined ? null : doc.resolve(options.dropAt);
  const opened = $drop !== null && !$drop.parent.isTextblock;
  const $at = $drop ?? (selection instanceof CellSelection ? selection.$anchorCell : view.state.tr.deleteSelection().selection.$from);
  const cell = selection instanceof CellSelection && $drop === null ? selection.$anchorCell : cellAround($at);
  const inCell = cell !== null && ($drop !== null || heldTables(selection) === null);
  // HTML with no media takes a code block's plain-text paste where the paste
  // stands in one code block, as BlockNote's default paste puts it there
  // (`pasteExtension.ts`).
  const startsInCode = $drop !== null ? $drop.parent.type.spec.code === true : selection.$from.parent.type.spec.code === true && selection.$from.sameParent(selection.$to);
  const source = content.source.kind === 'slice' ? content.source.slice : blocksSlice(content.source.blocks, schema);
  // A table in a cell goes by the cell's table rules (A12–A14) even from a code block.
  const plain = content.plain ?? (startsInCode && !(inCell && holdsNode(source.content, DOC_TABLE)) ? content.codeText ?? null : null);
  /**
   * Places content at its target, all of it or none: a placement that fails
   * part way leaves the body as it was. A drop's point is aimed first and its
   * hold on the selection from before the drop let go once the placement
   * ends. A paste over a selection whose ends are both in code blocks goes to
   * BlockNote's plain text paste, an input the body handles as its own, so
   * the tables it takes whole are turned into empty lines first (inner#1619).
   * @param place - Puts the content at the selection.
   * @returns Where it landed.
   * @throws {Error} What the placement threw, the body put back first.
   */
  const atTarget = (place: () => Placed | null): Placed | null => {
    const before = view.state.doc;
    try {
      if ($drop === null) {
        if (selection.$from.parent.type.spec.code && selection.$to.parent.type.spec.code) swapHeldTables(view);
      } else {
        aim(view, $drop, opened);
      }
      return place();
    } catch (error) {
      if (!view.state.doc.eq(before)) view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, before.content));
      throw error;
    } finally {
      if ($drop !== null) view.dispatch(view.state.tr.setMeta(HOLD_PRE_EDIT_SELECTION, false));
    }
  };
  if (!opened && textOnlyAt($at)?.node.firstChild?.type.name === 'codeBlock' && plain !== null) {
    return atTarget(() => {
      const from = view.state.selection.from;
      editor.pasteText(plain);
      return { kind: 'range', from, to: view.state.selection.head };
    });
  }
  if (refusedInCell(inCell, rowsOf(source).rows)) {
    toast.warning(t('spaces.document.paste.unsupportedInCell'));
    return null;
  }
  options.leaveOut?.(content.lost);
  // Every medium is judged once, before anything moves: a medium left out at
  // an end of the slice leaves that end at the line after it.
  const top: PMNode[] = [];
  source.content.forEach((node) => top.push(node));
  const kept = new Slice(Fragment.from(judged(top, options.judge, schema)), source.openStart, source.openEnd);
  const lines = rowsOf(kept);
  if (kept.content.size === 0 || !holdsContent(lines.rows, content.source.kind === 'slice' && content.source.parsed)) return null;
  return atTarget(() => putAtSelection(editor, kept, lines, options, opened));
}

/**
 * Puts judged content at the selection, by what the selection is (§5.4.3).
 * What goes in by ProseMirror's own paste (one line of words, the lines a
 * stored cell takes) has its transforms run there and only arrives without
 * row ids unless it moved; what the placement lays out is transformed on the
 * target first (`onTarget`).
 * @param editor - The editor.
 * @param kept - The content, its media judged.
 * @param lines - The content's lines, as read before any transform.
 * @param options - The placement's options.
 * @param opened - Whether the caret's line was opened by a drop, to be replaced rather than kept.
 * @returns Where the content landed.
 */
function putAtSelection(editor: Editor, kept: Slice, lines: Rows, options: PutOptions, opened: boolean): Placed | null {
  const view = editor.prosemirrorView!;
  const { selection } = view.state;
  const landed = options.landed === true;
  const pasted = landed ? [...lines.rows] : withoutRowIds(new Slice(Fragment.from(lines.rows), 0, 0)).content.content;
  /**
   * The content as our placement lays it out, transformed on the target.
   * @returns Its lines.
   */
  const placed = (): Rows => rowsOf(onTarget(view, kept, landed));
  const $cell = selection instanceof CellSelection ? selection.$anchorCell : cellAround(selection.$from);
  if ($cell !== null && heldTables(selection) === null && (selection instanceof CellSelection || onlyTable(lines.rows) !== null)) {
    const content = placed();
    const table = onlyTable(content.rows);
    if (table !== null) return putTableInCells(view, table);
    if (selection instanceof CellSelection) return putBlocksInCells(view, content.rows);
  }
  // One line of words goes into the line as its words, on the selection as
  // the reader made it; more lines go by the placement, which keeps the
  // reader's line its own type (§5.4.3).
  const words = isOneLine(lines);
  if (selection instanceof NodeSelection && !selection.node.isInline) return words ? putWords(view, pasted[0]!, options.byPaste) : replaceBlock(view, placed().rows, selection);
  // A gap cursor stands between blocks: its words are a block of their own,
  // placed by the gap like any other content.
  if (words && selection.$from.parent.isTextblock && textOnlyAt(selection.$from) === null) return putWords(view, pasted[0]!, options.byPaste);
  const replaced = !selection.empty || opened;
  if (!selection.empty) view.dispatch(view.state.tr.deleteSelection());
  const $caret = view.state.selection.$from;
  const target = textOnlyAt($caret);
  const content = placed();
  if (target !== null) return putInTextOnly(editor, content.rows, pasted, target, options);
  if (!$caret.parent.isTextblock) return putInGap(view, content.rows, $caret.parent.type.name === 'blockContainer' ? $caret.before() : $caret.pos);
  return putInLine(view, content, $caret, replaced);
}

/**
 * Puts content in the gap between two blocks the caret stands in (a gap
 * cursor's), every piece a block of its own, quoted when the line beside the
 * gap is, as ProseMirror's own paste there puts its blocks.
 * @param view - The view.
 * @param rows - The content.
 * @param gap - The gap.
 * @returns Where the content landed.
 */
function putInGap(view: EditorView, rows: readonly PMNode[], gap: number): Placed {
  const nodes = quotedBeside(view.state.doc, gap) ? quoted(rows) : [...rows];
  const tr = view.state.tr.insert(gap, nodes);
  finishCaret(tr, nodes, gap);
  view.dispatch(tr.scrollIntoView());
  return { kind: 'range', from: gap, to: gap + nodes.reduce((sum, node) => sum + node.nodeSize, 0) };
}

/**
 * Puts blocks already built, nothing read and every medium already
 * judged, at the selection or a drop's point: a canvas paste, files.
 * @param editor - The editor.
 * @param blocks - The blocks.
 * @param dropAt - A drop's point, when they were dropped there.
 * @returns Where they landed, or null when nothing went in.
 */
export function putBlocks(editor: Editor, blocks: readonly ReadBlock[], dropAt?: number): Placed | null {
  return putContent(
    editor,
    { source: { kind: 'blocks', blocks }, lost: 0, plain: null },
    { wordsIntoTarget: false, judge: (props) => props, byPaste: false, ...(dropAt !== undefined && { dropAt }) },
  );
}

/**
 * Replaces a selected block with content, every piece a block of its own.
 * @param view - The view.
 * @param rows - The content.
 * @param selection - The block selected.
 * @returns Where the content landed.
 */
function replaceBlock(view: EditorView, rows: readonly PMNode[], selection: NodeSelection): Placed | null {
  const line = selection.node.type.name === 'blockContainer' ? { node: selection.node, pos: selection.from } : lineAt(selection.$from);
  if (line === null) return null;
  const own = line.node.firstChild?.attrs[QUOTED] === true ? quoted(rows) : [...rows];
  const nodes = nestLast(own, line.node);
  const tr = view.state.tr.replaceWith(line.pos, line.pos + line.node.nodeSize, nodes);
  const size = nodes.reduce((sum, node) => sum + node.nodeSize, 0);
  finishCaret(tr, own, line.pos);
  view.dispatch(tr.scrollIntoView());
  return { kind: 'range', from: line.pos, to: line.pos + size };
}

/**
 * Puts content in the caret's line by one flow (§5.4.3 "placement has one
 * flow"): the line split at the caret into a front and a back, the content's
 * lines between them, its first line's words joining the front and its last
 * line's the back where they join, the rules of the placement table settling
 * the empty halves, the quote, the caret and the range once.
 * @param view - The view.
 * @param content - The content's lines.
 * @param $caret - The caret.
 * @param replaced - Whether the line, if empty, is one a deletion or a drop
 *   emptied, which the content replaces.
 * @returns Where the content landed.
 */
function putInLine(view: EditorView, content: Rows, $caret: ResolvedPos, replaced: boolean): Placed | null {
  const line = lineAt($caret);
  const own = line?.node.firstChild;
  if (line === null || own === undefined || own === null || !own.isTextblock) return null;
  const offset = $caret.parentOffset;
  const size = own.content.size;
  const nodes = own.attrs[QUOTED] === true ? quoted(content.rows) : [...content.rows];
  const firstWords = content.start === 'joins' && isWordsLine(nodes[0]);
  const lastWords = content.end === 'joins' && isWordsLine(nodes[nodes.length - 1]);
  const start = line.pos;
  const end = line.pos + line.node.nodeSize;
  const tr = view.state.tr;
  let laid: PMNode[];
  let caret: number | null = null;
  let from = start;
  let to: number;
  /**
   * Where a container laid at index `i` starts.
   * @param list - The containers.
   * @param i - The index.
   * @returns Its start.
   */
  const startOf = (list: readonly PMNode[], i: number): number => start + list.slice(0, i).reduce((sum, node) => sum + node.nodeSize, 0);

  if (size === 0) {
    const nonParagraph = own.type.name !== 'paragraph';
    if (firstWords && nonParagraph) nodes[0] = retyped(nodes[0]!, line.node);
    const last = nodes[nodes.length - 1]!;
    if (replaced) {
      laid = nestLast(nodes, line.node);
      tr.replaceWith(start, end, laid);
      finishCaret(tr, nodes, start);
      to = startOf(laid, laid.length);
    } else if (WORDS.has(typeOf(lastInReading(last))) && (!nonParagraph || WORDS.has(typeOf(last)))) {
      // An empty line becomes the last pasted block when the content ends in
      // words, keeping the line's id and nested blocks (§5.4.3), and a moved
      // line keeping its own id (A19): an empty plain line takes the block's
      // type and attributes; an empty heading, list item or to-do keeps its
      // own and takes the words and nested lines of a last block of words.
      // Content ending in a medium, or in a block that is not words with words
      // nested under it, leaves the line for the caret.
      const tail = nonParagraph ? retyped(last, line.node) : last;
      const id = carriedId(last) ?? line.node.attrs['id'];
      const put = [...nodes.slice(0, -1), tail.type.create({ ...tail.attrs, id }, tail.content)];
      laid = nestLast(put, line.node);
      tr.replaceWith(start, end, laid);
      finishCaret(tr, put, start);
      to = tr.selection.head;
    } else {
      // The empty line stays for the caret (inner#1127 A3).
      laid = [...nodes, line.node];
      tr.replaceWith(start, end, laid);
      to = startOf(laid, laid.length - 1);
      caret = to + 2;
    }
  } else {
    // The line splits at the caret into its own words before and after; a
    // half with words of its own is a line, which the content's first or
    // last line of words joins, and a half with none is not laid (at the
    // line's end nothing splits, and the line keeps its nested blocks).
    const lineId = line.node.attrs['id'] as string;
    const frontOwn = own.content.cut(0, offset);
    const backOwn = own.content.cut(offset);
    const firstJoined = firstWords && frontOwn.size > 0 ? nodes[0]!.firstChild!.content : null;
    const lastJoined = lastWords && backOwn.size > 0 ? nodes[nodes.length - 1]!.firstChild!.content : null;
    const frontLine = frontOwn.size > 0 ? lineWith(line.node, frontOwn.append(firstJoined ?? Fragment.empty), lineId, backOwn.size === 0) : null;
    const backLine = backOwn.size > 0 ? lineWith(line.node, (lastJoined ?? Fragment.empty).append(backOwn), frontLine === null ? lineId : newId(), true) : null;
    const middle = nodes.slice(firstJoined === null ? 0 : 1, lastJoined === null ? undefined : -1);
    laid = [...(frontLine === null ? [] : [frontLine]), ...middle, ...(backLine === null ? [] : [backLine])];
    tr.replaceWith(start, end, laid);
    const backStart = startOf(laid, laid.length - 1);
    const frontWords = start + 2 + frontOwn.size;
    // A split line's own halves bound what went in: the front's end and the
    // back's start, so a range over it takes leading and trailing media. At
    // the line's start nothing is split and the range starts at the block.
    from = frontLine === null ? start : firstJoined !== null || backLine !== null ? frontWords : startOf(laid, 1);
    if (backLine !== null) {
      to = lastJoined !== null && (frontLine !== null || lastJoined.size > 0) ? backStart + 2 + lastJoined.size : frontLine === null ? backStart : backStart + 2;
    } else {
      // When the line nests blocks of its own, the blocks put after the
      // joined words land after those nested lines, apart from the words:
      // the range is the joined words alone, and the rest stays unselected.
      to = firstJoined !== null && line.node.childCount > 1 ? frontWords + firstJoined.size : startOf(laid, laid.length);
    }
    if (lastJoined !== null) caret = backStart + 2 + lastJoined.size;
    else if (middle.length > 0) finishCaret(tr, middle, startOf(laid, frontLine === null ? 0 : 1));
    // The content's last line joined the front and its end only bounded it: the caret starts the back.
    else if (backLine !== null) caret = backStart + 2;
    else caret = frontWords + (firstJoined?.size ?? 0);
  }
  if (caret !== null) tr.setSelection(TextSelection.create(tr.doc, caret));
  view.dispatch(tr.scrollIntoView());
  return { kind: 'range', from, to };
}

/**
 * Selects what a drop put in, the way ProseMirror's own drop selects it (design
 * §5.4.1): one block alone that holds no words is selected whole, anything
 * else as a range whose ends `TextSelection.between` draws into the words put
 * in, never into the lines around them. Content with no words keeps the caret
 * its placement left (§5.4.3).
 * @param view - The view.
 * @param placed - Where it landed.
 */
export function selectPlaced(view: EditorView, placed: Placed): void {
  const { doc } = view.state;
  if (placed.kind === 'cells') {
    view.dispatch(view.state.tr.setSelection(CellSelection.create(doc, placed.anchor, placed.head)));
    return;
  }
  const from = Math.max(0, Math.min(placed.from, doc.content.size));
  const to = Math.max(from, Math.min(placed.to, doc.content.size));
  const atoms: number[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isBlock && node.isAtom && pos >= from && pos + node.nodeSize <= to) atoms.push(pos);
    return true;
  });
  if (atoms.length === 1 && doc.textBetween(from, to) === '') {
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(doc, atoms[0]!)));
    return;
  }
  const range = TextSelection.between(doc.resolve(from), doc.resolve(to));
  if (range.from < from || range.to > to) return;
  view.dispatch(view.state.tr.setSelection(range));
}
