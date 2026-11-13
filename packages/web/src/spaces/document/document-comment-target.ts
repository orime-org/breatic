// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which ranges can carry a comment (#18, A2 · A3).
 *
 * Both entries ask this of the same range type. The bubble bar acts on what
 * the user selected. The block handle acts on the row the pointer is over,
 * and `selectionOverBlockContent` turns that row into a selection over its own
 * content without dispatching it — so commenting on a whole block is the same
 * operation as selecting that block's text and commenting, which is what A2
 * asks for. One predicate for both means a row's answer cannot drift from a
 * selection's.
 *
 * The rule itself is R7's, already delivered for the colour panel: a range
 * that covers no run has no text for a press to mark, so the entry reads as
 * unavailable rather than looking usable and doing nothing
 * (`document-colour-run.ts`, `colourFaceOver`).
 *
 * A code block is not an exception. Measured on this build's schema, every
 * content node allows this mark and `codeBlock`'s mark set is exactly
 * `[comment]`: the library groups it as non-formatting, so code refuses bold
 * and italic while still taking a comment. Nothing extra is needed here for
 * that — asking the schema, which `reachesAnyRunOver` does, gets it right.
 *
 * That last point is why the question goes to the schema rather than to the
 * text: "does this range hold any characters" happens to give the same answer
 * on today's schema, since no content node here holds text and refuses this
 * mark, and a mutation swapping one for the other survives every case. The
 * schema is asked anyway, because it is the same walk the colour panel makes
 * (`eachRunOver`, which checks each run's parent) — one path, so the two
 * answers cannot diverge when a node arrives that does refuse it.
 *
 * This answers about the TEXT only. Whether the person may write at all is a
 * separate question with a separate answer (`documentCommentAuth`), because a
 * viewer looking at prose and an editor looking at a blank row are refused
 * for different reasons and the interface says different things about them.
 */

import type { Node as PMNode } from '@tiptap/pm/model';
import type { Selection } from '@tiptap/pm/state';

import { COMMENT_MARK } from '@web/spaces/document/document-comment-extension';
import { MATH_BLOCK, MATH_INLINE } from '@web/spaces/document/document-math';

import {
  markTypeIn,
  reachesAnyRunOver,
} from '@web/spaces/document/document-style-range';


/**
 * Whether the range holds any words outside formulas. A formula's source is
 * hidden behind its rendering, so a comment on it would mark text no one sees
 * (inner#1423, the same as a media block).
 * @param doc - The document.
 * @param over - The range.
 * @returns Whether some text in it sits outside a formula.
 */
function holdsWordsOutsideFormulas(doc: PMNode, over: Selection): boolean {
  let found = false;
  for (const { $from, $to } of over.ranges) {
    doc.nodesBetween($from.pos, $to.pos, (node, _pos, parent) => {
      if (found) return false;
      if (node.type.name === MATH_BLOCK || node.type.name === MATH_INLINE) return false;
      if (node.isText && parent !== null) found = true;
      return !found;
    });
    if (found) break;
  }
  return found;
}

/**
 * Whether the range holds any words, formula sources included: what the
 * handle's Add to Agent hands over, since the Agent reads a formula as its
 * `$$` source.
 * @param doc - The document.
 * @param over - The user's selection, or the range standing for one row.
 * @returns Whether the range holds text.
 */
export function holdsWordsOver(doc: PMNode, over: Selection): boolean {
  const mark = markTypeIn(doc, COMMENT_MARK);
  return mark !== undefined && reachesAnyRunOver(doc, over, mark);
}

/**
 * Whether a comment could land anywhere in this range.
 * @param doc - The document.
 * @param over - The user's selection, or the range standing for one row.
 * @returns Whether the range holds text a comment could mark.
 */
export function canCommentOver(doc: PMNode, over: Selection): boolean {
  // Either registrar `commentWiring` picks puts the mark on the schema, so
  // a missing mark is only reached by a caller holding some other schema.
  return holdsWordsOver(doc, over) && holdsWordsOutsideFormulas(doc, over);
}
