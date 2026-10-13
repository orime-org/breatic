// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A drag preview is shown outside the editor, and how the body draws its
 * content rests on where that content sits: the editor element's classes and
 * state, the elements around the editor, the blocks between the editor and the
 * content, each with rules and inherited values of its own (inner#1350 A1,
 * design §4 "样式"). Measured with the editor's classes alone on the preview,
 * it differed from the body in 6029 computed values, all from that chain.
 *
 * So a preview's content is put in shallow copies of every element from just
 * under the page's body down to the place it takes in the body, without the
 * moment's state. The copies are `doc-preview-shell` (`index.css`): they lay
 * out nothing (`display: contents`) and draw nothing of their own, while the
 * stylesheet's rules match through them and inherited values pass through
 * them as in the body. Nothing is read or written element by element, so the
 * cost does not grow with what the preview holds. BlockNote carries the editor
 * element's classes onto its clone the same way (`dragging.ts`), and Lexical
 * hands the body's own block element to `setDragImage`
 * (`LexicalDraggableBlockPlugin.tsx`).
 */

import type { EditorView } from '@tiptap/pm/view';

import { withoutViewState } from '@web/spaces/document/document-view-state';

/** The element in the body each copy takes the place of. */
const places = new WeakMap<Element, Element>();

/** The class `index.css` lays out and draws nothing of. */
const SHELL_CLASS = 'doc-preview-shell';

/**
 * What a copy of an element would give the page twice, and no rule styles by:
 * its id, the names a test or the page finds a Space or an element by, and
 * that the editor element takes typing.
 */
const NOT_COPIED = ['id', 'data-testid', 'data-space-outlet', 'contenteditable'];

/**
 * Records the element in the body a copy takes the place of, for it to be put
 * among copies of that element's ancestors. A copy recorded for none sits
 * where the body's own block group does, directly in the editor element.
 * @param copy - The copy.
 * @param original - The element in the body it takes the place of.
 */
export function standsFor(copy: Element, original: Element): void {
  places.set(copy, original);
}

/**
 * Puts content in shallow copies of the elements it sits in in the body, from
 * just under the page's body down, all without the moment's state. The
 * content itself had its state taken off when it was copied.
 * @param view - The editor view.
 * @param content - The content, detached.
 * @returns The outermost copy, holding the content.
 */
export function inPlaceOf(view: EditorView, content: Element): Element {
  const body = view.dom.ownerDocument.body;
  const ancestors: Element[] = [];
  for (let at: Element | null = places.get(content)?.parentElement ?? view.dom; at !== null && at !== body; at = at.parentElement) {
    ancestors.unshift(at);
  }
  const shells = ancestors.map((ancestor) => {
    const shell = ancestor.cloneNode(false) as Element;
    NOT_COPIED.forEach((name) => shell.removeAttribute(name));
    shell.classList.add(SHELL_CLASS);
    return shell;
  });
  shells.reduce((holder, shell) => {
    holder.append(shell);
    return shell;
  });
  const outermost = shells[0]!;
  withoutViewState(view, outermost);
  shells.at(-1)!.append(content);
  return outermost;
}
