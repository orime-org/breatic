// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two questions the link toolbar asks of the document: which link is under
 * the pointer, and which one is the caret in.
 *
 * Both answers come from {@link resolveLinkInSpan}, the one place a link's
 * range is worked out. What lives here is the judgement each route needs
 * before it can ask: the pointer route has an element and needs a position;
 * the caret route has a position and needs to know whether it is inside a link
 * at all.
 */

import type { EditorState } from '@tiptap/pm/state';

import {
  resolveLinkInSpan,
  LINK_ANCHOR_SELECTOR,
  type LinkRange,
  type LinkSelection,
} from '@web/spaces/document/document-link';
import { viewOf, type ViewedEditor } from '@web/spaces/document/document-editor-view';

/** No link, in the shape both answers take. */
const NOTHING: LinkSelection = { range: null, href: null };

/**
 * The link the given element holds.
 *
 * The element IS the link — the anchor a link mark renders as — so its length
 * is nobody's business here: one character of it is enough to name the run,
 * and `resolveLinkInSpan` reads the rest off the document.
 * @param editor - The editor the element belongs to.
 * @param element - The anchor, or anything inside one.
 * @returns The link and its address, both null when the element holds none.
 * @throws {never}
 */
export function linkAtElement(
  editor: ViewedEditor,
  element: HTMLElement,
): LinkSelection {
  const view = viewOf(editor);
  if (!view) return NOTHING;
  const at = view.posAtDOM(element, 0);
  return resolveLinkInSpan(view.state, at, at + 1);
}

/**
 * The anchor a link is drawn as right now.
 *
 * Asked rather than remembered: writing an address puts a different mark on
 * the text, and ProseMirror draws a new anchor for it — an element held from
 * before the write belongs to no document, and every question put to it about
 * the pointer answers for nobody.
 * @param editor - The editor holding the link.
 * @param range - Where the link is now.
 * @returns The anchor, or nothing when the range is not drawn as one.
 * @throws {never}
 */
export function anchorOfLink(
  editor: ViewedEditor,
  range: LinkRange,
): HTMLElement | null {
  const view = viewOf(editor);
  if (!view) return null;
  // Asked of the anchors themselves, the way `linkAtElement` asks. Reading
  // the document at a position instead needs one strictly inside the run, and
  // a run one character long has none: both of its positions are boundaries,
  // and a boundary belongs to the text on either side of it.
  const anchors = view.dom.querySelectorAll<HTMLElement>(LINK_ANCHOR_SELECTOR);
  for (const anchor of anchors) {
    const at = view.posAtDOM(anchor, 0);
    if (at >= range.from && at < range.to) return anchor;
  }
  return null;
}

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
