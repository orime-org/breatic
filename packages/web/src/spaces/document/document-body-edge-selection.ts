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

import type { Node, ResolvedPos } from '@tiptap/pm/model';
import { AllSelection, Selection } from '@tiptap/pm/state';
import type { Mappable } from '@tiptap/pm/transform';

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
  return Selection.near(doc.resolve(pos), edge === 'end' ? -1 : 1).head;
}

/**
 * A range from a position to an edge of the body.
 */
export class BodyEdgeSelection extends Selection {
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
  static create(doc: Node, anchor: number, edge: BodyEdge): BodyEdgeSelection {
    return BodyEdgeSelection.build(doc, 'head', edge, anchor);
  }

  /**
   * A selection whose anchor is on an edge and whose head is a text position.
   * @param doc - The document.
   * @param edge - The edge the anchor sits on.
   * @param head - The head.
   * @returns The selection.
   */
  static fromEdge(doc: Node, edge: BodyEdge, head: number): BodyEdgeSelection {
    return BodyEdgeSelection.build(doc, 'anchor', edge, head);
  }

  /**
   * Builds the selection with one end on an edge and the other in text.
   * @param doc - The document.
   * @param side - Which end sits on the edge.
   * @param edge - Which edge.
   * @param other - The other end, put into text.
   * @returns The selection.
   */
  private static build(doc: Node, side: EdgeSide, edge: BodyEdge, other: number): BodyEdgeSelection {
    const $edge = doc.resolve(edgePos(doc, edge));
    const $other = doc.resolve(textNear(doc, other, edge));
    return side === 'head'
      ? new BodyEdgeSelection($other, $edge)
      : new BodyEdgeSelection($edge, $other);
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
    return BodyEdgeSelection.build(doc, side, edge, mapping.map(other));
  }

  /**
   * Whether another selection is the same one.
   * @param other - The other selection.
   * @returns True for a body-edge selection with the same ends.
   */
  eq(other: Selection): boolean {
    return other instanceof BodyEdgeSelection && other.anchor === this.anchor && other.head === this.head;
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
    if (headEdge !== null) return BodyEdgeSelection.create(doc, json.anchor, headEdge);
    if (anchorEdge !== null) return BodyEdgeSelection.fromEdge(doc, anchorEdge, json.head);
    throw new RangeError('Invalid input for BodyEdgeSelection.fromJSON');
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

Selection.jsonID('bodyEdge', BodyEdgeSelection);

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
 * The selection that extends from an anchor to an edge of the body.
 * @param doc - The document.
 * @param anchor - The anchor.
 * @param edge - The edge to reach.
 * @returns A whole-document selection when the anchor is already on the other
 *   edge, otherwise a {@link BodyEdgeSelection}.
 */
export function extendToBodyEdge(doc: Node, anchor: number, edge: BodyEdge): Selection {
  const anchorEdge = edgeAt(doc, anchor);
  if (anchorEdge !== null && anchorEdge !== edge) return new AllSelection(doc);
  return BodyEdgeSelection.create(doc, anchor, edge);
}
