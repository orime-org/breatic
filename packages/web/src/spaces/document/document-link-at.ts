// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which link the caret is in.
 *
 * The answer comes from {@link resolveLinkInSpan}, the one place a link's range
 * is worked out. What lives here is the judgement the caret route needs before
 * it can ask: whether the caret is inside a link at all.
 *
 * The pointer route asks the same resolver with a position taken from the
 * pointer's coordinates. It used to come through here with an anchor element
 * instead, which cost it every case where an anchor is not the link: a write
 * rebuilds the element, a style inside a link splits it into several, and a
 * link one character long has no interior position to reach an element by.
 */

import type { EditorState } from '@tiptap/pm/state';

import {
  resolveLinkInSpan,
  type LinkSelection,
} from '@web/spaces/document/document-link';

/** No link, in the shape the answer takes. */
const NOTHING: LinkSelection = { range: null, href: null };

/**
 * The link the caret is in.
 *
 * Inside means both sides of the caret carry the same link: the boundaries of
 * a run are outside it, which is what keeps the toolbar off a link the reader
 * has just finished typing. A run one character long is the exception written
 * into the rule rather than patched around it — it has no interior, so its two
 * boundaries are all there is of it, and a caret that reaches such a link at
 * all reaches it at one of them.
 *
 * A selection holding text answers with nothing: the panel over a selection
 * owns that case, and two floating controls over one piece of text is what the
 * yield exists to prevent.
 * @param state - The editor state to read.
 * @returns The link and its address, both null when the caret is in none.
 * @throws {never}
 */
export function linkAtCaret(state: EditorState): LinkSelection {
  const { empty, from } = state.selection;
  const linkType = state.schema.marks.link;
  if (!empty || !linkType) return NOTHING;

  const $at = state.doc.resolve(from);
  const before = $at.nodeBefore?.marks.find((m) => m.type === linkType);
  const after = $at.nodeAfter?.marks.find((m) => m.type === linkType);

  if (before && after) {
    // Two different links meeting leave the caret inside neither.
    return before.eq(after) ? resolveLinkInSpan(state, from - 1, from + 1) : NOTHING;
  }

  const oneSide = before ? from - 1 : after ? from : null;
  if (oneSide === null) return NOTHING;
  const found = resolveLinkInSpan(state, oneSide, oneSide + 1);
  const length = found.range ? found.range.to - found.range.from : 0;
  return length === 1 ? found : NOTHING;
}
