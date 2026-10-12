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
 * So a preview's styles are worked out where its content sits: beside the
 * editor element, under a copy of it and of every element between it and the
 * place the content takes, the moment's state taken off them. Each element's
 * computed style is then written on it, and each pseudo-element's into a sheet
 * of the preview's own, so the preview draws as the body does wherever it is
 * put. Tiptap's drag handle copies computed styles the same way
 * (`extension-drag-handle/src/helpers/cloneElement.ts`), and html-to-image too,
 * pseudo-elements included (`src/clone-node.ts`, `src/clone-pseudos.ts`).
 */

import type { EditorView } from '@tiptap/pm/view';

import { withoutViewState } from '@web/spaces/document/document-view-state';

/** The element in the body each copy takes the place of. */
const places = new WeakMap<Element, Element>();

/**
 * A box's size, under every name a computed style gives it. The content's own
 * is the preview's: where its styles are worked out the body's block group
 * fills the editor element, and that fills its scroller.
 */
const SIZE = /^(min-|max-)?(width|height|inline-size|block-size)$/;

/**
 * How an element takes the pointer, which the preview's root sets for all of
 * it (`pointer-events: none`, inherited). Written from the body, the preview's
 * elements would take the pointer, and one pinned under it while the drag
 * starts ends the drag in Chromium.
 */
const INTERACTION = new Set([
  'pointer-events',
  'touch-action',
  'cursor',
  'user-select',
  '-webkit-user-select',
  '-webkit-user-drag',
  '-webkit-user-modify',
]);

/** The pseudo-elements a block draws with: list markers, a quote's rule. */
const PSEUDOS = ['::before', '::after'] as const;

/** What a pseudo-element's sheet finds an element by, numbered per preview. */
const PSEUDO_CLASS = 'doc-preview-pseudo-';

/** How many previews have been styled, which numbers each one's classes. */
let styled = 0;

/** One element's computed style, as declarations. */
type Declarations = ReadonlyArray<readonly [string, string]>;

/**
 * Records the element in the body a copy takes the place of, for its styles
 * to be worked out under that element's ancestors. A copy recorded for none
 * sits where the body's own block group does, directly in the editor element.
 * @param copy - The copy.
 * @param original - The element in the body it takes the place of.
 */
export function standsFor(copy: Element, original: Element): void {
  places.set(copy, original);
}

/**
 * Reads a computed style into declarations.
 * @param style - The computed style.
 * @returns Each property with its value.
 */
function declarationsOf(style: CSSStyleDeclaration): Declarations {
  return Array.from({ length: style.length }, (_, index) => style.item(index))
    .filter((property) => !INTERACTION.has(property))
    .map((property): [string, string] => [property, style.getPropertyValue(property)])
    .filter(([, value]) => value !== '');
}

/**
 * Puts content where it sits in the body: in a copy of the editor element,
 * inside copies of the elements between the editor element and the one it
 * takes the place of, all without the moment's state.
 * @param view - The editor view.
 * @param content - The content.
 * @returns The copy of the editor element, holding the content.
 */
function placeInBody(view: EditorView, content: Element): HTMLElement {
  const host = view.dom.cloneNode(false) as HTMLElement;
  host.removeAttribute('contenteditable');
  const ancestors: Element[] = [];
  const original = places.get(content);
  for (let at = original?.parentElement ?? null; at !== null && at !== view.dom; at = at.parentElement) {
    ancestors.unshift(at);
  }
  const inner = ancestors.reduce<Element>((holder, ancestor) => {
    const copy = ancestor.cloneNode(false) as Element;
    holder.append(copy);
    return copy;
  }, host);
  inner.append(content);
  withoutViewState(view, host);
  return host;
}

/**
 * Writes on every element of some content the style it takes where it sits in
 * the body, but what the element already sets on itself, and returns the
 * sheet its pseudo-elements are drawn by. The
 * content is in the body only while this runs, inside a copy of the editor
 * element put beside it, and is taken out again before it returns.
 * @param view - The editor view.
 * @param content - The content, detached.
 * @returns The sheet, to be put in the preview.
 */
export function writeBodyStyles(view: EditorView, content: HTMLElement): HTMLStyleElement {
  const page = view.dom.ownerDocument;
  const frame = page.defaultView ?? window;
  const host = placeInBody(view, content);
  const elements = [content, ...content.querySelectorAll<HTMLElement | SVGElement>('*')];
  view.dom.after(host);
  let own: Declarations[];
  let pseudos: Array<{ element: Element; pseudo: string; declarations: Declarations }>;
  try {
    own = elements.map((element) => declarationsOf(frame.getComputedStyle(element)));
    pseudos = elements.flatMap((element) =>
      PSEUDOS.map((pseudo) => ({ element, pseudo, style: frame.getComputedStyle(element, pseudo) }))
        .filter(({ style }) => !['none', 'normal', ''].includes(style.getPropertyValue('content')))
        .map(({ pseudo, style }) => ({ element, pseudo, declarations: declarationsOf(style) })),
    );
  } finally {
    host.remove();
  }
  content.remove();
  elements.forEach((element, index) => {
    // What the copy already says of itself is the preview's own: a width held
    // to the body's, the space taken off its ends, what was copied with it.
    // It stands as it is; a computed value can differ from it (WebKit computes
    // a `col` at 0px). It is written after the computed values, as a
    // declaration block takes the later of two that set one value: a computed
    // style also names it under another name (`inline-size` for `width`).
    const mine = Array.from({ length: element.style.length }, (_, at) => element.style.item(at)).map(
      (property): [string, string] => [property, element.style.getPropertyValue(property)],
    );
    const set = new Set(mine.map(([property]) => property));
    own[index]!.forEach(([property, value]) => {
      if (set.has(property) || (element === content && SIZE.test(property))) return;
      element.style.setProperty(property, value, 'important');
    });
    mine.forEach(([property, value]) => {
      element.style.removeProperty(property);
      element.style.setProperty(property, value, 'important');
    });
  });
  // Two previews can be on the page at once, the second built before the
  // first leaves; each one's sheet reaches its own elements alone.
  styled += 1;
  const sheet = page.createElement('style');
  sheet.textContent = pseudos
    .map(({ element, pseudo, declarations }, index) => {
      const name = `${PSEUDO_CLASS}${styled}-${index}`;
      element.classList.add(name);
      const body = declarations.map(([property, value]) => `${property}: ${value} !important;`).join(' ');
      return `.${name}${pseudo} { ${body} }`;
    })
    .join('\n');
  return sheet;
}
