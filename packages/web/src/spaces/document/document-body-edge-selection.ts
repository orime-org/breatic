// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A selection that reaches past the first or last block of the body (#124, A6).
 *
 * A range selection in ProseMirror is a `TextSelection`, and its ends have to
 * sit in text: `TextSelection.between` (prosemirror-state 1.4.4
 * `selection.ts:287-305`) pulls any other end back to the nearest text. When
 * the last block is a divider, a fallback block or an empty line, nothing
 * after it is text, so a drag or Shift+Down past the end can never take it in.
 * Framer and prosemirror-tables answer the same limit with their own Selection
 * subclass; this is that shape. Exactly one end sits on an edge of the body
 * and the other is a text position. The edges are inside the first and last
 * root blocks — before the first one's content, after everything in the last
 * one, nested blocks included — because BlockNote reads the block a selection
 * is in off its ends (`getTextCursorPosition`, its Enter and Tab handlers) and
 * finds none for a position between blocks.
 */

import { createExtension } from '@blocknote/core';
import type { Node, ResolvedPos } from '@tiptap/pm/model';
import { AllSelection, NodeSelection, Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import type { Mappable } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';

/** Which end of the body. */
export type BodyEdge = 'start' | 'end';

/** Which end of the selection sits on the edge. */
type EdgeSide = 'anchor' | 'head';

/**
 * The position of an edge of the body.
 * @param doc - The document.
 * @param edge - Which edge.
 * @returns `2`, inside the first root block before its content, for the
 *   start; `size - 2`, inside the last root block after all of it, for the
 *   end. No text position is either: text sits one level deeper, inside a
 *   block's content node.
 */
export function bodyEdgePos(doc: Node, edge: BodyEdge): number {
  return edge === 'start' ? 2 : doc.content.size - 2;
}

/**
 * Which edge a position is, if it is one.
 * @param doc - The document.
 * @param pos - The position.
 * @returns The edge, or null for any other position.
 */
export function bodyEdgeAt(doc: Node, pos: number): BodyEdge | null {
  if (pos === bodyEdgePos(doc, 'start')) return 'start';
  if (pos === bodyEdgePos(doc, 'end')) return 'end';
  return null;
}

/**
 * The position of the content node of the block at one end of the body: the
 * first root block's, or the last block's in document order, nested blocks
 * included.
 * @param doc - The document.
 * @param edge - Which end.
 * @returns The position, or null in an empty body.
 */
export function bodyEdgeBlockPos(doc: Node, edge: BodyEdge): number | null {
  const group = doc.firstChild;
  if (!group || group.childCount === 0) return null;
  if (edge === 'start') return 2;
  let container = group.lastChild!;
  let pos = 1 + group.content.size - container.nodeSize;
  while (container.lastChild?.type.name === 'blockGroup') {
    const nested = container.lastChild;
    const groupPos = pos + container.nodeSize - 1 - nested.nodeSize;
    container = nested.lastChild!;
    pos = groupPos + nested.nodeSize - 1 - container.nodeSize;
  }
  return pos + 1;
}

/**
 * Whether the block at this end of the body can only be reached by a selection
 * that goes past it: a block without text, or an empty line of any kind. An
 * empty line holds one position, at its start, so a range ending on it never
 * takes it in.
 * @param doc - The document.
 * @param edge - Which end.
 * @returns True when a text selection cannot take that block in.
 */
export function bodyEdgeNeedsTakeover(doc: Node, edge: BodyEdge): boolean {
  const pos = bodyEdgeBlockPos(doc, edge);
  const block = pos === null ? null : doc.nodeAt(pos);
  return block !== null && (!block.isTextblock || block.content.size === 0);
}

/**
 * The empty line at one end of the body, if that block is one.
 * @param doc - The document.
 * @param edge - Which end.
 * @returns The position of its node, or null when that block is not an empty line.
 */
export function emptyEdgeLinePos(doc: Node, edge: BodyEdge): number | null {
  const pos = bodyEdgeBlockPos(doc, edge);
  const block = pos === null ? null : doc.nodeAt(pos);
  return block?.isTextblock && block.content.size === 0 ? pos : null;
}

/**
 * The text position nearest to a position, looking one way first.
 * @param doc - The document.
 * @param pos - The position.
 * @param dir - The way to look first: -1 back, 1 forward.
 * @returns A position in text, or the position itself when there is no text.
 */
export function textToward(doc: Node, pos: number, dir: 1 | -1): number {
  const $pos = doc.resolve(pos);
  if ($pos.parent.inlineContent) return pos;
  return (Selection.findFrom($pos, dir, true) ?? Selection.findFrom($pos, -dir, true))?.head ?? pos;
}

/**
 * The text position nearest to a position, leaning towards the inside of the
 * body from the given edge.
 * @param doc - The document.
 * @param pos - The position.
 * @param edge - The edge the selection reaches, which decides the lean.
 * @returns A position in text, or the position itself when there is no text.
 */
function textNear(doc: Node, pos: number, edge: BodyEdge): number {
  return textToward(doc, pos, edge === 'end' ? -1 : 1);
}

/**
 * A range from a position to an edge of the body.
 */
class BodyEdgeSelectionClass extends Selection {
  /**
   * Builds the selection from its two resolved ends.
   * @param $anchor - The anchor.
   * @param $head - The head.
   */
  private constructor($anchor: ResolvedPos, $head: ResolvedPos) {
    super($anchor, $head);
  }

  /**
   * A selection whose head is on an edge and whose anchor is a text position.
   * @param doc - The document.
   * @param anchor - The anchor.
   * @param edge - The edge the head sits on.
   * @returns The selection.
   */
  static create(doc: Node, anchor: number, edge: BodyEdge): BodyEdgeSelectionClass {
    return BodyEdgeSelectionClass.build(doc, 'head', edge, anchor);
  }

  /**
   * A selection whose anchor is on an edge and whose head is a text position.
   * @param doc - The document.
   * @param edge - The edge the anchor sits on.
   * @param head - The head.
   * @returns The selection.
   */
  static fromEdge(doc: Node, edge: BodyEdge, head: number): BodyEdgeSelectionClass {
    return BodyEdgeSelectionClass.build(doc, 'anchor', edge, head);
  }

  /**
   * Builds the selection with one end on an edge and the other in text.
   * @param doc - The document.
   * @param side - Which end sits on the edge.
   * @param edge - Which edge.
   * @param other - The other end, put into text.
   * @returns The selection.
   */
  private static build(doc: Node, side: EdgeSide, edge: BodyEdge, other: number): BodyEdgeSelectionClass {
    const $edge = doc.resolve(bodyEdgePos(doc, edge));
    const $other = doc.resolve(textNear(doc, other, edge));
    return side === 'head'
      ? new BodyEdgeSelectionClass($other, $edge)
      : new BodyEdgeSelectionClass($edge, $other);
  }

  /**
   * Which end sits on the edge, and which edge.
   * @returns The side and the edge.
   */
  private edgeOf(): { side: EdgeSide; edge: BodyEdge; other: number } {
    const doc = this.$head.doc;
    const headEdge = bodyEdgeAt(doc, this.head);
    if (headEdge !== null) return { side: 'head', edge: headEdge, other: this.anchor };
    return { side: 'anchor', edge: bodyEdgeAt(doc, this.anchor)!, other: this.head };
  }

  /**
   * Maps the text end; the edge end stays on the same edge of the new document.
   * @param doc - The document after the change.
   * @param mapping - The change.
   * @returns The mapped selection.
   */
  map(doc: Node, mapping: Mappable): Selection {
    const { side, edge, other } = this.edgeOf();
    return BodyEdgeSelectionClass.build(doc, side, edge, mapping.map(other));
  }

  /**
   * Whether another selection is the same one.
   * @param other - The other selection.
   * @returns True for a body-edge selection with the same ends.
   */
  eq(other: Selection): boolean {
    return other instanceof BodyEdgeSelectionClass && other.anchor === this.anchor && other.head === this.head;
  }

  /**
   * The JSON form.
   * @returns `{ type, anchor, head }`.
   */
  toJSON(): { type: string; anchor: number; head: number } {
    return { type: 'bodyEdge', anchor: this.anchor, head: this.head };
  }

  /**
   * Reads the JSON form back. The end on an edge stays there; the other end is
   * put back into text, since a co-editor may have removed the block it was in.
   * @param doc - The document.
   * @param json - The JSON form.
   * @param json.anchor - The anchor.
   * @param json.head - The head.
   * @returns The selection, or a whole-document selection when both ends are edges.
   * @throws {RangeError} When neither end is an edge of the body.
   */
  static fromJSON(doc: Node, json: { anchor: number; head: number }): Selection {
    const headEdge = bodyEdgeAt(doc, json.head);
    const anchorEdge = bodyEdgeAt(doc, json.anchor);
    if (headEdge !== null && anchorEdge !== null && headEdge !== anchorEdge) return new AllSelection(doc);
    if (headEdge !== null) return BodyEdgeSelectionClass.create(doc, json.anchor, headEdge);
    if (anchorEdge !== null) return BodyEdgeSelectionClass.fromEdge(doc, anchorEdge, json.head);
    throw new RangeError('Invalid input for BodyEdgeSelectionClass.fromJSON');
  }

  /**
   * A bookmark that comes back as the same class.
   * @returns The bookmark.
   */
  getBookmark(): BodyEdgeBookmark {
    const { side, edge, other } = this.edgeOf();
    return new BodyEdgeBookmark(side, edge, other);
  }
}

/**
 * The key the registered class is kept under. ProseMirror keeps one registry of
 * selection classes per loaded `prosemirror-state`, and registering an id twice
 * throws. This module can be evaluated more than once against the same
 * registry (hot reload, one test worker running several files), so the first
 * class registered is kept on `Selection` itself and every later evaluation
 * uses that one: one registry entry, one class for `instanceof`.
 */
const REGISTERED = Symbol.for('breatic.document.bodyEdgeSelection');

/** `Selection`, seen as the holder of the registered class. */
const holder = Selection as unknown as { [REGISTERED]?: typeof BodyEdgeSelectionClass };
if (holder[REGISTERED] === undefined) {
  holder[REGISTERED] = BodyEdgeSelectionClass;
  Selection.jsonID('bodyEdge', BodyEdgeSelectionClass);
}

/** The selection class, as registered with ProseMirror. */
export const BodyEdgeSelection = holder[REGISTERED];

/** The bookmark of a {@link BodyEdgeSelection}. */
class BodyEdgeBookmark {
  /**
   * Stores the edge and the text end.
   * @param side - Which end sits on the edge.
   * @param edge - Which edge.
   * @param other - The text end.
   */
  constructor(
    private readonly side: EdgeSide,
    private readonly edge: BodyEdge,
    private readonly other: number,
  ) {}

  /**
   * Maps the text end.
   * @param mapping - The change.
   * @returns The mapped bookmark.
   */
  map(mapping: Mappable): BodyEdgeBookmark {
    return new BodyEdgeBookmark(this.side, this.edge, mapping.map(this.other));
  }

  /**
   * Resolves the bookmark in a document.
   * @param doc - The document.
   * @returns The selection.
   */
  resolve(doc: Node): Selection {
    return this.side === 'head'
      ? BodyEdgeSelection.create(doc, this.other, this.edge)
      : BodyEdgeSelection.fromEdge(doc, this.edge, this.other);
  }
}

/**
 * A caret in the text nearest an edge of the body.
 * @param doc - The document.
 * @param edge - Which edge.
 * @returns A text caret, or the nearest selection of any kind when the body
 *   holds no text.
 */
function caretNear(doc: Node, edge: BodyEdge): Selection {
  const pos = textNear(doc, bodyEdgePos(doc, edge), edge);
  const $pos = doc.resolve(pos);
  return $pos.parent.inlineContent ? TextSelection.create(doc, pos) : Selection.near($pos, edge === 'end' ? -1 : 1);
}

/**
 * The selection from one position to another, either of which may be an edge
 * of the body.
 * @param doc - The document.
 * @param anchor - The anchor.
 * @param head - The head.
 * @returns A text selection when neither end is an edge; a
 *   {@link BodyEdgeSelection} when one is; a caret beside the edge when both
 *   are the same edge; the whole document when they are the two edges.
 */
export function bodyEdgeBetween(doc: Node, anchor: number, head: number): Selection {
  const anchorEdge = bodyEdgeAt(doc, anchor);
  const headEdge = bodyEdgeAt(doc, head);
  if (anchorEdge !== null && headEdge !== null) {
    return anchorEdge === headEdge ? caretNear(doc, anchorEdge) : new AllSelection(doc);
  }
  if (anchorEdge !== null) return BodyEdgeSelection.fromEdge(doc, anchorEdge, head);
  if (headEdge !== null) return BodyEdgeSelection.create(doc, anchor, headEdge);
  return TextSelection.between(doc.resolve(anchor), doc.resolve(head));
}

/**
 * The ends of a selection with an end on an edge of the body moved into the
 * nearest text, for whoever places something at an end. A collaborator's
 * caret is drawn at the head (y-prosemirror `cursor-plugin.js:106-118`), and an
 * edge sits inside a block but outside its content, where a caret element has
 * no line to stand on.
 * @param selection - The selection.
 * @returns Its anchor and head, each in text or where it was.
 */
export function textEnds(selection: Selection): { anchor: number; head: number } {
  if (!(selection instanceof BodyEdgeSelection)) return { anchor: selection.anchor, head: selection.head };
  const doc = selection.$head.doc;
  /**
   * Moves a position on an edge into the nearest text.
   * @param pos - The position.
   * @returns The text position, or the position itself when it is no edge.
   */
  const intoText = (pos: number): number => {
    const edge = bodyEdgeAt(doc, pos);
    return edge === null ? pos : textNear(doc, pos, edge);
  };
  return { anchor: intoText(selection.anchor), head: intoText(selection.head) };
}

/**
 * The caret a selection is dropped to when a panel acting on it closes: at its
 * end, in the nearest text when that end is an edge of the body.
 * @param selection - The selection.
 * @returns A text caret.
 */
export function caretAtEnd(selection: Selection): Selection {
  const { anchor, head } = textEnds(selection);
  return TextSelection.create(selection.$head.doc, Math.max(anchor, head));
}

/**
 * The selection that extends from an anchor to an edge of the body.
 * @param doc - The document.
 * @param anchor - The anchor.
 * @param edge - The edge to reach.
 * @returns See {@link bodyEdgeBetween}.
 */
export function extendToBodyEdge(doc: Node, anchor: number, edge: BodyEdge): Selection {
  return bodyEdgeBetween(doc, anchor, bodyEdgePos(doc, edge));
}

/** Where the pointer is: over the body, or past the block at one of its ends. */
export type PointerZone = 'body' | BodyEdge;

/** A drag the pointer plugin is following. */
export interface EdgeDrag {
  /** Where it was pressed; `shift` for a Shift+click the pointer plugin answers. */
  readonly press: PointerZone | 'shift';
  /** The anchor the selection keeps. */
  readonly anchor: number;
  /** Whether the pointer has been anywhere but where it was pressed. */
  readonly left: boolean;
}

/**
 * The selection a drag gives (design §5.10.3, the press × pointer table).
 * @param doc - The document.
 * @param drag - The drag.
 * @param zone - Where the pointer is now.
 * @param pointer - The document position under the pointer, when it is over
 *   the body; null when there is none.
 * @returns The selection, or null to leave it to ProseMirror and the browser.
 */
export function dragSelection(doc: Node, drag: EdgeDrag, zone: PointerZone, pointer: number | null): Selection | null {
  if (zone !== 'body') {
    if (drag.press === zone && !drag.left) return null;
    return extendToBodyEdge(doc, drag.anchor, zone);
  }
  if (drag.press === 'body' && !drag.left) return null;
  if (pointer === null) return null;
  return bodyEdgeBetween(doc, drag.anchor, pointer);
}

/**
 * Which edge a position the page reported stands for. The page can only say
 * "past the last block" as the position between blocks — the edge this module
 * writes, `size - 2`, reads back from the page as `size - 1` (measured,
 * probe15), since BlockNote's block element is not the block's content
 * element — so both the model's edge and the one beside it outside the block
 * count. Only an edge whose block a text selection cannot reach counts: past a
 * last block with words the browser's own range is right.
 * @param doc - The document.
 * @param pos - The position the page reported.
 * @returns The edge, or null.
 */
function pageEdgeAt(doc: Node, pos: number): BodyEdge | null {
  const edge =
    bodyEdgeAt(doc, pos) ?? (pos === 1 ? 'start' : pos === doc.content.size - 1 ? 'end' : null);
  return edge !== null && bodyEdgeNeedsTakeover(doc, edge) ? edge : null;
}

/**
 * Keeps an end that sits on an edge when the browser's range is read back
 * (design §5.10.5): after a drag that anchored past the last block, a
 * Shift+click or a Shift+arrow extends the browser's range from there, and
 * `TextSelection.between` would pull that end back into text.
 * @param view - The view.
 * @param $anchor - The browser's anchor.
 * @param $head - The browser's head.
 * @returns The selection, or null when the range is collapsed or neither end
 *   is an edge {@link pageEdgeAt} counts.
 */
function readBackAtEdge(view: EditorView, $anchor: ResolvedPos, $head: ResolvedPos): Selection | null {
  const { doc } = view.state;
  if ($anchor.pos === $head.pos) return null;
  const anchorEdge = pageEdgeAt(doc, $anchor.pos);
  const headEdge = pageEdgeAt(doc, $head.pos);
  if (anchorEdge === null && headEdge === null) return null;
  const anchor = anchorEdge === null ? $anchor.pos : bodyEdgePos(doc, anchorEdge);
  const head = headEdge === null ? $head.pos : bodyEdgePos(doc, headEdge);
  return bodyEdgeBetween(doc, anchor, head);
}

/**
 * Whether the head is on the line of text nearest this edge, with the edge
 * block still outside the selection: the last line of the last text block for
 * the end, the first line of the first for the start.
 * @param view - The view.
 * @param edge - Which edge.
 * @returns True when an arrow towards that edge has no text left to reach.
 */
function atLastLineTowards(view: EditorView, edge: BodyEdge): boolean {
  const { doc, selection } = view.state;
  if (!bodyEdgeNeedsTakeover(doc, edge)) return false;
  const { $head } = selection;
  if (!$head.parent.isTextblock) return false;
  const dir = edge === 'end' ? 1 : -1;
  const beyond = doc.resolve(dir > 0 ? $head.after() : $head.before());
  if (Selection.findFrom(beyond, dir, true) !== null) return false;
  return view.endOfTextblock(edge === 'end' ? 'down' : 'up');
}

/** The arrow keys: which way each goes, and whether it goes by lines. */
const ARROWS: Readonly<Record<string, { dir: 1 | -1; vertical: boolean }>> = {
  ArrowUp: { dir: -1, vertical: true },
  ArrowDown: { dir: 1, vertical: true },
  ArrowLeft: { dir: -1, vertical: false },
  ArrowRight: { dir: 1, vertical: false },
};

/**
 * The text next to a selected block on one side, or the edge of the body when
 * there is no text that way.
 * @param doc - The document.
 * @param selection - The block's node selection.
 * @param side - Which side: -1 before it, 1 after it.
 * @returns The position.
 */
function besideBlock(doc: Node, selection: NodeSelection, side: 1 | -1): number {
  const found = Selection.findFrom(side < 0 ? selection.$from : selection.$to, side, true);
  return found?.head ?? bodyEdgePos(doc, side < 0 ? 'start' : 'end');
}

/**
 * The end of the body a selection that holds the whole document stands on:
 * the edge when the block there needs it, else the text nearest it.
 * @param doc - The document.
 * @param edge - Which end.
 * @returns The position.
 */
function wholeDocumentEnd(doc: Node, edge: BodyEdge): number {
  const pos = bodyEdgePos(doc, edge);
  return bodyEdgeNeedsTakeover(doc, edge) ? pos : textNear(doc, pos, edge);
}

/**
 * The anchor and head a selection is extended from (design §5.10.4): a
 * selection over the whole document runs from the start to the end, and a
 * selected block runs from the text behind it to the text past it in the
 * direction of the extension, so the block stays inside.
 * @param selection - The selection.
 * @param dir - Which way it is being extended.
 * @returns The two ends; every other selection keeps its own.
 */
export function extensionEnds(selection: Selection, dir: 1 | -1): { anchor: number; head: number } {
  const doc = selection.$head.doc;
  if (selection instanceof AllSelection) {
    return { anchor: wholeDocumentEnd(doc, 'start'), head: wholeDocumentEnd(doc, 'end') };
  }
  if (selection instanceof NodeSelection && !selection.node.isInline) {
    return { anchor: besideBlock(doc, selection, dir < 0 ? 1 : -1), head: besideBlock(doc, selection, dir) };
  }
  return { anchor: selection.anchor, head: selection.head };
}

/**
 * The next position for a head in text, one character or one block along;
 * past the last text it is the edge, when the block there needs one.
 * @param doc - The document.
 * @param head - The head, in text.
 * @param dir - Which way.
 * @returns The position.
 */
function stepFrom(doc: Node, head: number, dir: 1 | -1): number {
  const $head = doc.resolve(head);
  if (dir < 0 ? $head.parentOffset > 0 : $head.parentOffset < $head.parent.content.size) return head + dir;
  const next = Selection.findFrom(doc.resolve(dir < 0 ? $head.before() : $head.after()), dir, true);
  if (next) return next.head;
  const edge: BodyEdge = dir < 0 ? 'start' : 'end';
  return bodyEdgeNeedsTakeover(doc, edge) ? bodyEdgePos(doc, edge) : head;
}

/**
 * The text position a line up or down from a head in text, as the browser
 * lays the lines out: a caret put at the head and moved by a line
 * (`Selection.modify`). The browser does not extend a range anchored on the
 * start edge itself — that anchor stands on no line (probe25) — so a selection
 * with an end on an edge is moved here rather than left to it.
 * @param view - The view.
 * @param head - The head, in text.
 * @param dir - Which way.
 * @returns The position, or null when the page cannot move a caret by lines.
 */
function lineFrom(view: EditorView, head: number, dir: 1 | -1): number | null {
  const dom = (view.root as Document).getSelection?.();
  if (!dom || typeof dom.modify !== 'function') return null;
  const { anchorNode, anchorOffset, focusNode, focusOffset } = dom;
  const at = view.domAtPos(head);
  dom.collapse(at.node, at.offset);
  dom.modify('move', dir < 0 ? 'backward' : 'forward', 'line');
  const moved = dom.focusNode && view.dom.contains(dom.focusNode) ? view.posAtDOM(dom.focusNode, dom.focusOffset) : null;
  // Put the page's range back: ProseMirror reads it on the next selection
  // change, and a key that changes nothing dispatches nothing to overwrite it.
  if (anchorNode && focusNode) dom.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
  return moved === null ? null : textToward(view.state.doc, moved, dir);
}

/**
 * The selection a Shift+arrow gives (design §5.10.4) on a selection reaching
 * past an end, the whole document or a selected block, which ProseMirror
 * would collapse or lose (prosemirror-view `capturekeys.ts:19-55`); and on a
 * text selection whose head has no text left that way.
 * @param view - The view.
 * @param key - The arrow.
 * @returns The new selection, the current one when nothing changes, or null
 *   when the key is left to ProseMirror and the browser.
 */
function arrowOnEdge(view: EditorView, key: string): Selection | null {
  const { doc, selection } = view.state;
  const { dir, vertical } = ARROWS[key]!;
  const edge: BodyEdge = dir > 0 ? 'end' : 'start';
  if (selection instanceof NodeSelection && !selection.node.isInline) {
    const { anchor, head } = extensionEnds(selection, dir);
    return bodyEdgeBetween(doc, anchor, head);
  }
  if (!(selection instanceof BodyEdgeSelection) && !(selection instanceof AllSelection)) {
    return vertical && atLastLineTowards(view, edge) ? extendToBodyEdge(doc, selection.anchor, edge) : null;
  }
  const { anchor, head } = extensionEnds(selection, dir);
  const headEdge = bodyEdgeAt(doc, head);
  if (headEdge === edge) return selection;
  if (headEdge !== null) return bodyEdgeBetween(doc, anchor, textNear(doc, head, headEdge));
  if (!vertical) return bodyEdgeBetween(doc, anchor, stepFrom(doc, head, dir));
  if (atLastLineTowards(view, edge)) return bodyEdgeBetween(doc, anchor, bodyEdgePos(doc, edge));
  const next = lineFrom(view, head, dir);
  return next === null ? null : bodyEdgeBetween(doc, anchor, next);
}

/**
 * The caret plain Left or Right leaves a selection reaching past an end at:
 * its start or its end, in text, as for any range.
 * @param selection - The selection.
 * @param key - The arrow.
 * @returns The caret, or null when the key is left to ProseMirror.
 */
function collapseOnEdge(selection: Selection, key: string): Selection | null {
  if (!(selection instanceof BodyEdgeSelection) || ARROWS[key]!.vertical) return null;
  const { anchor, head } = textEnds(selection);
  const at = ARROWS[key]!.dir < 0 ? Math.min(anchor, head) : Math.max(anchor, head);
  return TextSelection.create(selection.$head.doc, at);
}

/**
 * Handles the arrows on selections ProseMirror does not move the way a range
 * moves (#124, A6), and Shift+arrows that reach an edge of the body.
 * @param view - The view.
 * @param event - The key press.
 * @returns True when the key was taken.
 */
function onKeyDown(view: EditorView, event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey || !Object.hasOwn(ARROWS, event.key)) return false;
  const next = event.shiftKey ? arrowOnEdge(view, event.key) : collapseOnEdge(view.state.selection, event.key);
  if (next === null) return false;
  if (!next.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(next).scrollIntoView());
  return true;
}

/**
 * The extension that lets the reader's selection reach past the first or last
 * block of the body.
 * @returns The extension, for the assembly to register.
 */
export const documentBodyEdgeExtension = createExtension(() => {
  return {
    key: 'document-body-edge',
    prosemirrorPlugins: [
      new Plugin({
        key: new PluginKey('documentBodyEdge'),
        props: { handleKeyDown: onKeyDown, createSelectionBetween: readBackAtEdge },
      }),
    ],
  } as never;
});
