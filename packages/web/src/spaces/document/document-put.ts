// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where pasted or dropped content goes (inner#1351 + inner#1390 design
 * §5.4.3): the target settled from the selection first, then one set of
 * placement rules for web content, the body's own content, canvas nodes and
 * files alike, and the caret after what was put. Content goes in as blocks
 * built here; lines of words alone go in by the paste of their format, and
 * the words a table cell or a code block takes by ProseMirror, the table's
 * own paste and BlockNote.
 */

import { blockToNode, type BlockNoteEditor } from '@blocknote/core';
import { Fragment, type Node as PMNode, type ResolvedPos } from '@tiptap/pm/model';
import { NodeSelection, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';

import { newId } from '@breatic/shared';

import { quotedAs } from '@web/spaces/document/document-file-input';
import { QUOTED } from '@web/spaces/document/document-list-block';
import { isMediaBlockType } from '@web/spaces/document/document-media-types';
import { holdsBlocks, textOf, type Inline, type Read, type ReadBlock } from '@web/spaces/document/document-paste-read';

/** How a medium lands: its props as they go in, or null when it is left out. */
export type JudgeMedium = (props: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>> | null;

/** What is put: blocks, the media left out reading them, the plain text, and how words alone go in. */
export type Content = Pick<Read, 'blocks' | 'lost' | 'plain'> & { readonly paste: Read['paste'] | null };

/** What a placement needs besides the content. */
export interface PutOptions {
  /**
   * Whether a table cell or a code block takes the words while the media go
   * beside it (a paste or a drop); otherwise the whole content goes beside
   * it (a canvas paste, files).
   */
  readonly wordsIntoTarget: boolean;
  /** Judges every medium put in; one left out is counted by whoever judged it. */
  readonly judge: JudgeMedium;
  /** Told how many media reading left out, unless a code block took the plain text as it is. */
  readonly leaveOut?: (count: number) => void;
  /** Whether the caret's line was opened by a drop, to be replaced rather than kept. */
  readonly openedLine?: boolean;
}

/** Where content landed, for a drop to select. */
export type Placed =
  | { readonly kind: 'range'; readonly from: number; readonly to: number }
  | { readonly kind: 'cells'; readonly anchor: number; readonly head: number };

/** The editor the placement works through. */
type Editor = Pick<BlockNoteEditor<never, never, never>, 'pasteHTML' | 'pasteText' | 'blocksToFullHTML'> & {
  readonly prosemirrorView: EditorView | undefined | null;
};

/** Block types whose content is words, which join a line they are put in. */
const WORDS = new Set(['paragraph', 'heading', 'bulletListItem', 'numberedListItem', 'checkListItem', 'toggleListItem', 'quote']);

/**
 * Whether a block is a line of words with nothing nested: what joins the
 * line it is put in at the open ends of the content.
 * @param block - The block.
 * @returns True for such a line.
 */
function isWordsLine(block: ReadBlock | undefined): block is ReadBlock {
  return block !== undefined && WORDS.has(block.type) && (block.children ?? []).length === 0;
}

/**
 * Blocks with every medium judged: those left out go, their nested blocks
 * taking their place.
 * @param blocks - The blocks.
 * @param judge - The judge.
 * @returns The blocks.
 */
function judged(blocks: readonly ReadBlock[], judge: JudgeMedium): ReadBlock[] {
  return blocks.flatMap((block): ReadBlock[] => {
    const children = judged(block.children ?? [], judge);
    if (!isMediaBlockType(block.type)) return [{ ...block, children }];
    const props = judge(block.props ?? {});
    return props === null ? children : [{ ...block, props, children }];
  });
}

/**
 * A block with an id, its nested blocks too, so no two blocks put in share one.
 * @param block - The block.
 * @returns The block.
 */
function withIds(block: ReadBlock): ReadBlock & { id: string } {
  return { ...block, id: newId(), children: (block.children ?? []).map(withIds) };
}

/**
 * Blocks as block containers.
 * @param blocks - The blocks.
 * @param state - The state they go into.
 * @returns The containers.
 */
function containers(blocks: readonly ReadBlock[], state: EditorState): PMNode[] {
  return blocks.map((block) => blockToNode(withIds(block) as never, state.schema));
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
 * The table or code block a position is in, as the block container holding it.
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
 * Every medium among blocks, nested ones too, and the blocks without them,
 * a medium's nested blocks taking its place.
 * @param blocks - The blocks.
 * @returns The media and the rest.
 */
function takeMedia(blocks: readonly ReadBlock[]): { media: ReadBlock[]; rest: ReadBlock[] } {
  const media: ReadBlock[] = [];
  /**
   * The blocks without their media.
   * @param list - The blocks.
   * @returns The rest.
   */
  const strip = (list: readonly ReadBlock[]): ReadBlock[] =>
    list.flatMap((block): ReadBlock[] => {
      const children = strip(block.children ?? []);
      if (!isMediaBlockType(block.type)) return [{ ...block, children }];
      media.push({ type: block.type, props: block.props ?? {} });
      return children;
    });
  return { media, rest: strip(blocks) };
}

/**
 * The words of a block's own content: its inline content, or a table's
 * cells, a tab between cells and a line each row, as a table copies as text.
 * @param content - The content.
 * @returns The words.
 */
function contentWords(content: unknown): string {
  if (Array.isArray(content)) return textOf(content as Inline[]);
  const rows = (content as { rows?: { cells: unknown[] }[] } | undefined)?.rows ?? [];
  return rows
    .map((row) => row.cells.map((cell) => textOf((Array.isArray(cell) ? cell : ((cell as { content?: Inline[] }).content ?? [])) as Inline[])).join('\t'))
    .join('\n');
}

/**
 * The words of blocks, one line each, nested ones too.
 * @param blocks - The blocks.
 * @returns The text.
 */
function wordsOf(blocks: readonly ReadBlock[]): string {
  return blocks.flatMap((block) => [contentWords(block.content), ...(block.children ?? []).map((child) => wordsOf([child]))]).join('\n');
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
 * Puts the caret after content ending at `end`: at the start of the line that
 * follows in reading order when it holds words, else in an empty line opened
 * there, quoted as the block before it (Lexical's `insertNodes` leaves the
 * caret after the last block it puts; ProseMirror has no caret between
 * blocks, so a line holds it).
 * @param tr - The transaction.
 * @param end - Where the content ends.
 */
function caretAfter(tr: Transaction, end: number): void {
  let $next = tr.doc.resolve(end);
  // Past the end of a nested group, the line that follows is the next one after its parent.
  while ($next.nodeAfter === null && $next.depth > 0) $next = tr.doc.resolve($next.after());
  const after = $next.nodeAfter;
  if (after?.type.name === 'blockContainer' && after.firstChild?.isTextblock === true) {
    tr.setSelection(TextSelection.create(tr.doc, $next.pos + 2));
    return;
  }
  const quoted = tr.doc.resolve(end).nodeBefore?.firstChild?.attrs[QUOTED] === true;
  tr.insert(end, blockToNode({ id: newId(), type: 'paragraph', props: { [QUOTED]: quoted } } as never, tr.doc.type.schema));
  tr.setSelection(TextSelection.create(tr.doc, end + 2));
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
  const group = last.childCount > 1 ? last.lastChild!.content.append(line.lastChild!.content) : line.lastChild!.content;
  const content = Fragment.from([last.firstChild!, line.lastChild!.type.create(null, group)]);
  return [...nodes.slice(0, -1), last.type.create(last.attrs, content)];
}

/**
 * Puts content in a block that takes only words, a table or a code block: the
 * words go in first, by the table's own paste, ProseMirror or BlockNote's
 * plain text paste, and the media beside the block afterwards, found again by
 * its id. An empty code block counts as an empty line: the media go above it
 * and the caret stays in it.
 * @param editor - The editor.
 * @param content - The content.
 * @param target - The table's or the code block's container.
 * @param target.node - The container.
 * @param target.pos - Where it starts.
 * @param options - The placement's options.
 * @returns The words put in the block; the cells a table's paste filled; else the last medium put beside it.
 */
function putInTextOnly(editor: Editor, content: Content, target: { node: PMNode; pos: number }, options: PutOptions): Placed {
  const view = editor.prosemirrorView!;
  const id = target.node.attrs['id'] as string;
  const code = target.node.firstChild!.type.name === 'codeBlock';
  const aside = options.wordsIntoTarget ? takeMedia(content.blocks) : { media: [...content.blocks], rest: [] };
  const beside = judged(aside.media, options.judge);
  const from = view.state.selection.from;
  if (aside.rest.length > 0) {
    if (code) editor.pasteText(wordsOf(aside.rest));
    else if (aside.media.length === 0 && content.paste !== null) content.paste(editor as never);
    else editor.pasteHTML(editor.blocksToFullHTML(aside.rest as never), true);
  }
  const after = view.state.selection;
  const cells = after instanceof CellSelection ? after : null;
  const words: Placed | null = aside.rest.length > 0 && cells === null ? { kind: 'range', from: Math.min(from, after.head), to: after.head } : null;
  const found = beside.length === 0 ? null : containerById(view.state.doc, id);
  if (found === null) return cells !== null ? cellsOf(cells) : (words ?? { kind: 'range', from, to: from });
  const blockContent = found.node.firstChild!;
  const media = containers(quotedAs(beside, blockContent.attrs[QUOTED] === true), view.state);
  const emptyCode = blockContent.type.name === 'codeBlock' && blockContent.content.size === 0;
  const at = emptyCode ? found.pos : found.pos + found.node.nodeSize;
  const tr = view.state.tr.insert(at, media);
  const size = media.reduce((sum, node) => sum + node.nodeSize, 0);
  if (emptyCode) tr.setSelection(TextSelection.create(tr.doc, at + size + 2));
  else caretAfter(tr, at + size);
  view.dispatch(tr.scrollIntoView());
  if (cells !== null) return cellsOf(cells.map(tr.doc, tr.mapping) as CellSelection);
  if (words !== null) return words;
  return { kind: 'range', from: at + size - media[media.length - 1]!.nodeSize, to: at + size };
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
 * Pastes lines of words alone at the selection, the way BlockNote pastes their format.
 * @param editor - The editor.
 * @param content - The content.
 * @returns Where the words landed.
 */
function pasteWords(editor: Editor, content: Content): Placed {
  const view = editor.prosemirrorView!;
  const from = view.state.selection.from;
  if (content.paste !== null) content.paste(editor as never);
  else editor.pasteHTML(editor.blocksToFullHTML(content.blocks as never), true);
  return { kind: 'range', from, to: view.state.selection.head };
}

/**
 * Puts content at the selection (§5.4.3). The selection settles the target
 * first: in a code block, plain text goes in as it is; a cell selection
 * keeps for the table's paste; a selected block is replaced in place; a text
 * selection outside a table and a code block takes lines of words alone by
 * the paste of their format; any other text selection is deleted and the
 * caret's line judged.
 * @param editor - The editor.
 * @param content - The content, its media not judged yet.
 * @param options - The placement's options.
 * @returns Where the content landed, or null when nothing went in.
 */
export function putContent(editor: Editor, content: Content, options: PutOptions): Placed | null {
  const view = editor.prosemirrorView;
  if (view === undefined || view === null) return null;
  const { selection } = view.state;
  const cellSelection = selection instanceof CellSelection;
  const textOnly = selection instanceof NodeSelection ? null : textOnlyAt(cellSelection ? selection.$anchorCell : selection.$from);
  if (!cellSelection && textOnly?.node.firstChild?.type.name === 'codeBlock' && content.plain !== null) {
    const from = selection.from;
    editor.pasteText(content.plain);
    return { kind: 'range', from, to: view.state.selection.head };
  }
  options.leaveOut?.(content.lost);
  if (content.blocks.length === 0) return null;
  if (cellSelection) return textOnly === null ? null : putInTextOnly(editor, content, textOnly, options);
  const words = !holdsBlocks(content.blocks);
  if (selection instanceof NodeSelection) return words ? pasteWords(editor, content) : replaceBlock(view, content.blocks, selection, options);
  if (words && textOnly === null) return pasteWords(editor, content);
  const replaced = !selection.empty || options.openedLine === true;
  if (!selection.empty) view.dispatch(view.state.tr.deleteSelection());
  const $caret = view.state.selection.$from;
  const target = textOnlyAt($caret);
  if (target !== null) return putInTextOnly(editor, content, target, options);
  return putInLine(view, content.blocks, $caret, replaced, options);
}

/**
 * Replaces a selected block with content, every piece a block of its own.
 * @param view - The view.
 * @param blocks - The content.
 * @param selection - The block selected.
 * @param options - The placement's options.
 * @returns Where the content landed.
 */
function replaceBlock(view: EditorView, blocks: readonly ReadBlock[], selection: NodeSelection, options: PutOptions): Placed | null {
  const line = selection.node.type.name === 'blockContainer' ? { node: selection.node, pos: selection.from } : lineAt(selection.$from);
  if (line === null) return null;
  const content = judged(blocks, options.judge);
  if (content.length === 0) return null;
  const isQuoted = line.node.firstChild?.attrs[QUOTED] === true;
  const nodes = nestLast(containers(isQuoted ? quotedAs(content, true) : content, view.state), line.node);
  const tr = view.state.tr.replaceWith(line.pos, line.pos + line.node.nodeSize, nodes);
  const size = nodes.reduce((sum, node) => sum + node.nodeSize, 0);
  finishCaret(tr, nodes, line.pos);
  view.dispatch(tr.scrollIntoView());
  return { kind: 'range', from: line.pos, to: line.pos + size };
}

/**
 * Puts the caret after content laid out from `start`: at the end of its last
 * line when that is words, else after it (`caretAfter`).
 * @param tr - The transaction.
 * @param nodes - The containers laid out.
 * @param start - Where they start.
 */
function finishCaret(tr: Transaction, nodes: readonly PMNode[], start: number): void {
  const last = nodes[nodes.length - 1]!;
  const end = start + nodes.reduce((sum, node) => sum + node.nodeSize, 0);
  if (last.firstChild?.isTextblock === true && last.childCount === 1) {
    tr.setSelection(TextSelection.create(tr.doc, end - 2));
    return;
  }
  caretAfter(tr, end);
}

/**
 * Puts content in the caret's line by the placement table (§5.4.3).
 * @param view - The view.
 * @param blocks - The content.
 * @param $caret - The caret.
 * @param replaced - Whether the line, if empty, is one a deletion or a drop
 *   emptied, which the content replaces.
 * @param options - The placement's options.
 * @returns Where the content landed.
 */
function putInLine(view: EditorView, blocks: readonly ReadBlock[], $caret: ResolvedPos, replaced: boolean, options: PutOptions): Placed | null {
  const line = lineAt($caret);
  const own = line?.node.firstChild;
  let content = judged(blocks, options.judge);
  if (line === null || own === undefined || own === null || !own.isTextblock || content.length === 0) return null;
  if (own.attrs[QUOTED] === true) content = quotedAs(content, true);
  const { state } = view;
  const nodes = containers(content, state);
  const firstWords = nodes.length > 1 && isWordsLine(content[0]);
  const lastWords = nodes.length > 1 && isWordsLine(content[content.length - 1]);
  const offset = $caret.parentOffset;
  const size = own.content.size;
  const start = line.pos;
  const end = line.pos + line.node.nodeSize;
  const tr = state.tr;
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
    if (replaced) {
      laid = nestLast(nodes, line.node);
      tr.replaceWith(start, end, laid);
      finishCaret(tr, laid, start);
      to = startOf(laid, laid.length);
    } else if (lastWords) {
      const tail = nodes[nodes.length - 1]!;
      laid = [...nodes.slice(0, -1), lineWith(line.node, tail.firstChild!.content, line.node.attrs['id'] as string, true)];
      tr.replaceWith(start, end, laid);
      caret = startOf(laid, laid.length - 1) + 2 + tail.firstChild!.content.size;
      to = caret;
    } else {
      laid = [...nodes, line.node];
      tr.replaceWith(start, end, laid);
      caret = startOf(laid, laid.length - 1) + 2;
      to = startOf(laid, laid.length - 1);
    }
  } else if (offset === size) {
    // At the end of the line: it does not split, its nested blocks stay.
    const head = firstWords ? lineWith(line.node, own.content.append(nodes[0]!.firstChild!.content), line.node.attrs['id'] as string, true) : line.node;
    const rest = firstWords ? nodes.slice(1) : nodes;
    laid = [head, ...rest];
    tr.replaceWith(start, end, laid);
    from = firstWords ? start + 2 + size : startOf(laid, 1);
    to = startOf(laid, laid.length);
    if (rest.length === 0) caret = to - 2;
    else finishCaret(tr, rest, startOf(laid, 1));
  } else {
    const lineId = line.node.attrs['id'] as string;
    const front = offset === 0 ? null : own.content.cut(0, offset).append(firstWords ? nodes[0]!.firstChild!.content : Fragment.empty);
    const backWords = lastWords ? nodes[nodes.length - 1]!.firstChild!.content : Fragment.empty;
    const back = backWords.append(own.content.cut(offset));
    const middle = nodes.slice(firstWords && front !== null ? 1 : 0, lastWords ? -1 : undefined);
    laid = [
      ...(front === null ? [] : [lineWith(line.node, front, lineId, false)]),
      ...middle,
      lineWith(line.node, back, front === null ? lineId : newId(), true),
    ];
    tr.replaceWith(start, end, laid);
    const backStart = startOf(laid, laid.length - 1);
    caret = backStart + 2 + backWords.size;
    from = front === null ? start : firstWords ? start + 2 + offset : startOf(laid, 1);
    to = lastWords ? caret : backStart;
  }
  if (caret !== null) tr.setSelection(TextSelection.create(tr.doc, caret));
  view.dispatch(tr.scrollIntoView());
  return { kind: 'range', from, to };
}

/**
 * Selects what a drop put in, the way ProseMirror's own drop selects it: one
 * block alone that holds no words is selected whole, anything else as a range.
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
  const $from = doc.resolve(from);
  const only = $from.nodeAfter;
  if (only?.type.name === 'blockContainer' && from + only.nodeSize === to && only.firstChild !== null && !only.firstChild.isTextblock) {
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(doc, from + 1)));
    return;
  }
  view.dispatch(view.state.tr.setSelection(TextSelection.between(doc.resolve(from), doc.resolve(to)) as Selection));
}
