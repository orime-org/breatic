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

/** Where a preview's content stands in the body. */
interface Standing {
  /** The element it takes the place of; null when it sits where the body's own block group does. */
  readonly place: Element | null;
  /** The element it is drawn as wide as; null when the body has none to go by. */
  readonly sizedLike: Element | null;
}

declare const PLACED: unique symbol;

/** Content copied out of the body for a drag preview, its standing recorded by {@link placed}. */
export type PlacedContent<Element extends HTMLElement = HTMLElement> = Element & { readonly [PLACED]: true };

/** Each placed content's standing. */
const standings = new WeakMap<Element, Standing>();

/** The class `index.css` lays out and draws nothing of. */
const SHELL_CLASS = 'doc-preview-shell';

/**
 * What a copy of an element would give the page twice, and no rule styles by:
 * its id, and the names a test or the page finds a Space or an element by.
 * `contenteditable` stays: the editor's rules select by it (`@tiptap/core`
 * `style.ts`), and a copy that is no box takes no focus.
 */
const NOT_COPIED = ['id', 'data-testid', 'data-space-outlet'];

/**
 * Records where content copied out of the body stands there: the element it
 * takes the place of, and the element it is drawn as wide as. A preview takes
 * only content so recorded, which is laid out at that width where it is
 * drawn, as in the body (inner#1350 design §4).
 * @param content - The copied content.
 * @param place - The element it takes the place of; null when it sits where the body's own block group does.
 * @param sizedLike - The element it is drawn as wide as; null when the body has none to go by.
 * @returns The content.
 */
export function placed<Content extends HTMLElement>(
  content: Content,
  place: Element | null,
  sizedLike: Element | null,
): PlacedContent<Content> {
  standings.set(content, { place, sizedLike });
  return content as PlacedContent<Content>;
}

/**
 * The width placed content is drawn at in the body.
 * @param content - The content.
 * @returns The width, 0 when the body has none to go by.
 */
export function drawnWidthOf(content: PlacedContent): number {
  return standings.get(content)?.sizedLike?.getBoundingClientRect().width ?? 0;
}

/**
 * Puts content in shallow copies of the elements it sits in in the body, from
 * just under the page's body down, all without the moment's state. The
 * content itself had its state taken off when it was copied.
 * @param view - The editor view.
 * @param content - The content, detached.
 * @returns The outermost copy, holding the content.
 */
export function inPlaceOf(view: EditorView, content: PlacedContent): Element {
  const body = view.dom.ownerDocument.body;
  const ancestors: Element[] = [];
  for (let at: Element | null = standings.get(content)?.place?.parentElement ?? view.dom; at !== null && at !== body; at = at.parentElement) {
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
