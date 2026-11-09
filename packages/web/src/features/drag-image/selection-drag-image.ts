// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { mountDragImage } from '@web/lib/drag-image';

/**
 * Draws the image that follows the pointer while a selection is dragged out
 * of a single-block editor (the prompt box, the Agent input, a canvas text
 * node), the way every editor's drag image is drawn (`lib/drag-image.ts`,
 * inner#1515). The browser draws its own image of a selection fainter than
 * one handed to it (Chromium and WebKit 0.75), and tiptap's NodeView sets one
 * for a chip only when React receives the event, which Safari never does.
 * Best-effort: any failure falls back to the browser's own image (a visual
 * enhancement, not a business error).
 * @param view - The editor view.
 * @param event - The dragstart event.
 */
export function setSelectionDragImage(view: EditorView, event: Event): void {
  const dt = (event as DragEvent).dataTransfer;
  if (!dt || typeof dt.setDragImage !== 'function') return;
  const sel = view.state.selection;
  if (sel.empty) return;
  try {
    const page = view.dom.ownerDocument;
    const range = page.createRange();
    const fromDom = view.domAtPos(sel.from);
    const toDom = view.domAtPos(sel.to);
    range.setStart(fromDom.node, fromDom.offset);
    range.setEnd(toDom.node, toDom.offset);
    // The dragged content keeps its own line layout (same width and font as
    // the source, so soft-wraps reproduce) and the image is anchored at the
    // press point's offset INSIDE the content, as the browser's own image of a
    // selection is.
    const rect = range.getBoundingClientRect();
    const editorStyle = getComputedStyle(view.dom);
    const content = page.createElement('div');
    content.style.width = `${Math.ceil(rect.width)}px`;
    content.style.whiteSpace = 'pre-wrap';
    // Font LONGHANDS, never the shorthand: Chrome's computed `font` is often
    // the EMPTY string (unrepresentable sub-property combos), which left the
    // image inheriting the body's 16px.
    content.style.fontFamily = editorStyle.fontFamily;
    content.style.fontSize = editorStyle.fontSize;
    content.style.fontWeight = editorStyle.fontWeight;
    content.style.lineHeight = editorStyle.lineHeight;
    content.style.color = editorStyle.color;
    content.appendChild(range.cloneContents());
    const { root, scale } = mountDragImage(page, content);
    const pointer = event as DragEvent;
    const offsetX = Math.max(0, pointer.clientX - rect.left) * scale;
    const offsetY = Math.max(0, pointer.clientY - rect.top) * scale;
    dt.setDragImage(root, offsetX, offsetY);
  } catch {
    // The browser's own image stays — the enhancement must never break the drag.
  }
}

/**
 * The drag image of a selection, for an editor that handles no `dragstart`
 * of its own (the canvas text node). The prompt editors call
 * {@link setSelectionDragImage} from their own `dragstart`, after restoring
 * the selection a chip drag spans.
 */
export const SelectionDragImage = Extension.create({
  name: 'selectionDragImage',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('selectionDragImage'),
        props: {
          handleDOMEvents: {
            dragstart: (view, event): boolean => {
              setSelectionDragImage(view, event);
              return false;
            },
          },
        },
      }),
    ];
  },
});
