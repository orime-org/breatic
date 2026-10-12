// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the body paints for the moment rather than for its content: the
 * selection, a comment being read or drafted, a link being edited, a table
 * line held or dropped on, a block refusing a Tab, an upload on its way, the
 * empty document's hint (inner#1350 A1).
 *
 * A copy of the body takes all of it along, and a drag preview is a copy: the
 * same blocks would come out painted one way or another by how they happened
 * to be selected. A preview shows the content alone, the way Chromium draws
 * selected text being dragged without its selection behind it
 * (`text_fragment_painter.cc`, `PaintPhase::kSelectionDragImage`).
 *
 * Every decoration of that kind in the body is made here, and each records in
 * its spec what it adds, so a copy can be taken back to the content without a
 * list of names kept somewhere else. A decoration that is part of how the
 * content looks (a quote's rule, an unsupported block's label) is made with
 * `Decoration` itself.
 */

import { Decoration } from '@tiptap/pm/view';
import type { DecorationAttrs } from '@tiptap/pm/view';

/** The spec key a view-state decoration records what it adds under. */
const RECORD = 'docViewState';

/** The attribute a view-state widget's element carries. */
const WIDGET_ATTRIBUTE = 'data-view-state';

/** What a view-state decoration adds to the elements it lands on. */
interface ViewStateRecord {
  readonly classes: readonly string[];
  readonly attributes: readonly string[];
}

/** The arguments of `Decoration.widget`. */
type WidgetArgs = Parameters<typeof Decoration.widget>;

/**
 * What some decoration attributes add: their classes, and every other
 * attribute but `style` (which only sets custom properties the classes and
 * attributes read).
 * @param attrs - The attributes.
 * @returns The record.
 */
function recordOf(attrs: DecorationAttrs): ViewStateRecord {
  const classes = (attrs.class ?? '').split(/\s+/).filter((name) => name !== '');
  const attributes = Object.keys(attrs).filter((name) => name !== 'class' && name !== 'style' && name !== 'nodeName');
  return { classes, attributes };
}

/** The decorations for what the body shows for the moment. */
export const viewState = {
  /**
   * A node decoration for what the body shows for the moment.
   * @param from - Where the node starts.
   * @param to - Where it ends.
   * @param attrs - What it adds to the node's element.
   * @param spec - The decoration's own spec.
   * @returns The decoration.
   */
  node(from: number, to: number, attrs: DecorationAttrs, spec?: Record<string, unknown>): Decoration {
    return Decoration.node(from, to, attrs, { ...spec, [RECORD]: recordOf(attrs) });
  },
  /**
   * An inline decoration for what the body shows for the moment.
   * @param from - Where the range starts.
   * @param to - Where it ends.
   * @param attrs - What it adds to the range's elements.
   * @param spec - The decoration's own spec.
   * @returns The decoration.
   */
  inline(from: number, to: number, attrs: DecorationAttrs, spec?: Record<string, unknown>): Decoration {
    return Decoration.inline(from, to, attrs, { ...spec, [RECORD]: recordOf(attrs) });
  },
  /**
   * A widget for what the body shows for the moment; its element is marked so
   * a copy can leave it out.
   * @param pos - Where it sits.
   * @param toDOM - Builds its element.
   * @param spec - The decoration's own spec.
   * @returns The decoration.
   */
  widget(pos: number, toDOM: WidgetArgs[1], spec?: WidgetArgs[2]): Decoration {
    /**
     * Builds the widget's element and marks it.
     * @param view - The editor view.
     * @param getPos - Where the widget sits now.
     * @returns The element.
     */
    const marked: WidgetArgs[1] = (view, getPos): Node => {
      const dom = typeof toDOM === 'function' ? toDOM(view, getPos) : toDOM;
      if (dom instanceof Element) dom.setAttribute(WIDGET_ATTRIBUTE, '');
      return dom;
    };
    return Decoration.widget(pos, marked, spec);
  },
};

