// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A drag preview shows the content alone (inner#1350 A1). It is a copy of the
 * body, and the body also wears what it shows for the moment: the selection, a
 * collaborator's caret and selection, a comment being read, a link being
 * edited, a table line held, a block refusing a Tab, an upload on its way, the
 * slash menu's query, a column being resized, a medium the pointer is over.
 * The same blocks would come out painted one way or another by how they
 * happened to be selected and who else was in the document. Chromium draws
 * selected text being dragged without its selection behind it
 * (`text_fragment_painter.cc`, `PaintPhase::kSelectionDragImage`).
 *
 * So everything a decoration adds comes off the copy, whoever made it, and so
 * does every widget; a decoration that is part of how the content looks says
 * so in its spec ({@link CONTENT_DECORATION}) and stays.
 */

import type { Decoration, DecorationAttrs, EditorView } from '@tiptap/pm/view';

/** The spec key a content decoration carries. */
const CONTENT = 'docContent';

/**
 * The spec of a decoration that is part of how the content looks — a list's
 * numbers, a quote's rule, an unsupported block's label — which a drag preview
 * keeps.
 */
export const CONTENT_DECORATION: Readonly<Record<string, true>> = Object.freeze({ [CONTENT]: true });

/**
 * What the body shows for the moment that is no decoration: the class
 * prosemirror-view puts on a selected node, and the media box's hover and
 * selected state, written by its own view (`DocumentMediaBlock`).
 */
const SELECTED_NODE_CLASS = 'ProseMirror-selectednode';
const VIEW_ATTRIBUTES = ['data-hovered', 'data-selected'];

/** Every widget prosemirror-view draws carries this class (`spec.raw` aside). */
const WIDGET = '.ProseMirror-widget';

/** What the decorations now in the view add, to be taken off a copy. */
interface Added {
  readonly classes: Set<string>;
  readonly attributes: Set<string>;
  readonly properties: Set<string>;
}

/**
 * The attributes a node or inline decoration adds. prosemirror-view keeps them
 * on the decoration's type; a widget's type has none.
 * @param decoration - The decoration.
 * @returns Its attributes, or undefined for a widget.
 */
function attrsOf(decoration: Decoration): DecorationAttrs | undefined {
  return (decoration as unknown as { type: { attrs?: DecorationAttrs } }).type.attrs;
}

/**
 * Adds what some decoration attributes put on an element to a tally.
 * @param attrs - The attributes.
 * @param added - The tally.
 */
function tally(attrs: DecorationAttrs, added: Added): void {
  Object.entries(attrs).forEach(([name, value]) => {
    if (name === 'nodeName' || typeof value !== 'string') return;
    if (name === 'class') {
      value.split(/\s+/).filter((token) => token !== '').forEach((token) => added.classes.add(token));
    } else if (name === 'style') {
      value
        .split(';')
        .map((declaration) => declaration.split(':')[0]?.trim() ?? '')
        .filter((property) => property !== '')
        .forEach((property) => added.properties.add(property));
    } else {
      added.attributes.add(name);
    }
  });
}

/**
 * What the decorations now in the view add, but for the content's own.
 * @param view - The editor view.
 * @returns The classes, attributes and style properties.
 */
function addedByDecorations(view: EditorView): Added {
  const added: Added = { classes: new Set(), attributes: new Set(), properties: new Set() };
  view.someProp('decorations', (decorations) => {
    decorations(view.state)?.forEachSet((set) => {
      set.find().forEach((decoration) => {
        const attrs = attrsOf(decoration);
        if (attrs !== undefined && (decoration.spec as Record<string, unknown>)[CONTENT] !== true) {
          tally(attrs, added);
        }
      });
    });
  });
  return added;
}

/**
 * Takes what the body shows for the moment off a copy of it, leaving the
 * content: every widget, what every decoration but the content's own adds, the
 * selected node's class and the media box's state.
 * @param view - The editor view the copy was taken from.
 * @param copy - The copy.
 */
export function withoutViewState(view: EditorView, copy: Element): void {
  const added = addedByDecorations(view);
  copy.querySelectorAll(WIDGET).forEach((widget) => {
    widget.remove();
  });
  [copy, ...copy.querySelectorAll('*')].forEach((el) => {
    el.classList.remove(SELECTED_NODE_CLASS);
    VIEW_ATTRIBUTES.forEach((name) => el.removeAttribute(name));
    added.classes.forEach((name) => el.classList.remove(name));
    added.attributes.forEach((name) => el.removeAttribute(name));
    if (el instanceof HTMLElement) added.properties.forEach((property) => el.style.removeProperty(property));
    if (el.getAttribute('class') === '') el.removeAttribute('class');
    if (el.getAttribute('style') === '') el.removeAttribute('style');
  });
}
