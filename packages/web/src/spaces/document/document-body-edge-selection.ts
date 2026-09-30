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
 * subclass; this is that shape. Exactly one end sits on an edge of the body:
 * `1`, before the first block of the root group, or `size - 1`, after the last.
 * The other end is a text position.
 */

import { createExtension } from '@blocknote/core';
import type { Node, ResolvedPos } from '@tiptap/pm/model';
import { AllSelection, Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
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
 * @returns `1` for the start, `size - 1` for the end.
 */
function edgePos(doc: Node, edge: BodyEdge): number {
  return edge === 'start' ? 1 : doc.content.size - 1;
}

/**
 * Which edge a position is, if it is one.
 * @param doc - The document.
 * @param pos - The position.
 * @returns The edge, or null for any other position.
 */
function edgeAt(doc: Node, pos: number): BodyEdge | null {
  if (pos === edgePos(doc, 'start')) return 'start';
  if (pos === edgePos(doc, 'end')) return 'end';
  return null;
}

/**
 * The content node of the block at one end of the body, nested blocks
 * included at the end: the last block in document order.
 * @param doc - The document.
 * @param edge - Which end.
 * @returns That block's content node, or null in an empty body.
 */
function blockAtEdge(doc: Node, edge: BodyEdge): Node | null {
  const group = doc.firstChild;
  let container = edge === 'start' ? group?.firstChild : group?.lastChild;
  if (edge === 'end') {
    while (container?.lastChild?.type.name === 'blockGroup') {
      container = container.lastChild.lastChild;
    }
  }
  return container?.firstChild ?? null;
}

/**
 * Whether the block at this end of the body can only be reached by a selection
 * that goes past it: a block without text, or an empty paragraph.
 * @param doc - The document.
 * @param edge - Which end.
 * @returns True when a text selection cannot take that block in.
 */
export function bodyEdgeNeedsTakeover(doc: Node, edge: BodyEdge): boolean {
  const block = blockAtEdge(doc, edge);
  if (block === null) return false;
  if (!block.isTextblock) return true;
  return block.type.name === 'paragraph' && block.content.size === 0;
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
  const $pos = doc.resolve(pos);
  if ($pos.parent.inlineContent) return pos;
  const inward = edge === 'end' ? -1 : 1;
  const found = Selection.findFrom($pos, inward, true) ?? Selection.findFrom($pos, -inward, true);
  return found?.head ?? pos;
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
    const $edge = doc.resolve(edgePos(doc, edge));
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
    const headEdge = edgeAt(doc, this.head);
    if (headEdge !== null) return { side: 'head', edge: headEdge, other: this.anchor };
    return { side: 'anchor', edge: edgeAt(doc, this.anchor) ?? 'end', other: this.head };
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
    const headEdge = edgeAt(doc, json.head);
    const anchorEdge = edgeAt(doc, json.anchor);
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
  const $edge = doc.resolve(edgePos(doc, edge));
  const inward = edge === 'end' ? -1 : 1;
  return (
    Selection.findFrom($edge, inward, true) ??
    Selection.findFrom($edge, -inward, true) ??
    Selection.near($edge, inward)
  );
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
  const anchorEdge = edgeAt(doc, anchor);
  const headEdge = edgeAt(doc, head);
  if (anchorEdge !== null && headEdge !== null) {
    return anchorEdge === headEdge ? caretNear(doc, anchorEdge) : new AllSelection(doc);
  }
  if (anchorEdge !== null) return BodyEdgeSelection.fromEdge(doc, anchorEdge, head);
  if (headEdge !== null) return BodyEdgeSelection.create(doc, anchor, headEdge);
  return TextSelection.between(doc.resolve(anchor), doc.resolve(head));
}

/**
 * The selection that extends from an anchor to an edge of the body.
 * @param doc - The document.
 * @param anchor - The anchor.
 * @param edge - The edge to reach.
 * @returns See {@link bodyEdgeBetween}.
 */
export function extendToBodyEdge(doc: Node, anchor: number, edge: BodyEdge): Selection {
  return bodyEdgeBetween(doc, anchor, edgePos(doc, edge));
}

/** Where the pointer is: over the body, or past the block at one of its ends. */
export type PointerZone = 'body' | BodyEdge;

/** A drag the pointer plugin is following. */
export interface EdgeDrag {
  /** Where it was pressed; `shift` for a Shift+click past an edge. */
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
    return bodyEdgeBetween(doc, drag.anchor, edgePos(doc, zone));
  }
  if (drag.press === 'body' && !drag.left) return null;
  if (pointer === null) return null;
  return bodyEdgeBetween(doc, drag.anchor, pointer);
}

/**
 * Keeps an end that sits on an edge when the browser extends the selection
 * (design §5.10.5). Reading the browser's range back goes through
 * `TextSelection.between`, which would pull that end back into text.
 * @param view - The view.
 * @param $anchor - The browser's anchor.
 * @param $head - The browser's head.
 * @returns The selection, or null when neither end is an edge or the range is
 *   collapsed.
 */
function readBackAtEdge(view: EditorView, $anchor: ResolvedPos, $head: ResolvedPos): Selection | null {
  const { doc } = view.state;
  if ($anchor.pos === $head.pos) return null;
  if (edgeAt(doc, $anchor.pos) === null && edgeAt(doc, $head.pos) === null) return null;
  return bodyEdgeBetween(doc, $anchor.pos, $head.pos);
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

/**
 * The selection a Shift+arrow gives on an edge selection, or on a text
 * selection that has no text left in that direction.
 * @param view - The view.
 * @param key - The arrow.
 * @returns The new selection, the current one when nothing changes, or null
 *   when the key is left to ProseMirror and the browser.
 */
function arrowOnEdge(view: EditorView, key: string): Selection | null {
  const { doc, selection } = view.state;
  const edge: BodyEdge | null =
    key === 'ArrowDown' ? 'end' : key === 'ArrowUp' ? 'start' : null;
  if (selection instanceof BodyEdgeSelection) {
    const headEdge = edgeAt(doc, selection.head);
    if (headEdge !== null) {
      const inward = headEdge === 'end' ? ['ArrowUp', 'ArrowLeft'] : ['ArrowDown', 'ArrowRight'];
      if (!inward.includes(key)) return selection;
      const head = textNear(doc, edgePos(doc, headEdge), headEdge);
      return TextSelection.create(doc, selection.anchor, head);
    }
    const anchorEdge = edgeAt(doc, selection.anchor) ?? 'end';
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const target = selection.head + (key === 'ArrowLeft' ? -1 : 1);
      return BodyEdgeSelection.fromEdge(doc, anchorEdge, target);
    }
    return null;
  }
  if (edge !== null && atLastLineTowards(view, edge)) {
    return extendToBodyEdge(doc, selection.anchor, edge);
  }
  return null;
}

/**
 * Handles Shift+arrows that reach, stay on or leave an edge of the body
 * (#124, A6). ProseMirror collapses any selection other than a text selection
 * on Left and Right (prosemirror-view `capturekeys.ts:19-55`), so those are
 * taken here as well.
 * @param view - The view.
 * @param event - The key press.
 * @returns True when the key was taken.
 */
function onKeyDown(view: EditorView, event: KeyboardEvent): boolean {
  if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return false;
  const next = arrowOnEdge(view, event.key);
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
