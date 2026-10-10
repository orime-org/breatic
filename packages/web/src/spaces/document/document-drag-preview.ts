// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The image that follows the pointer while a row, a block or a table line is
 * dragged (inner#1350 A1).
 *
 * Every preview is built here and nowhere else, because three things have to
 * hold for all of them at once:
 *
 * - It is measured on the dragged content itself: a text block has no width of
 *   its own and takes the body column's, a media block is its media box, a
 *   table is every one of its columns (its scroll frame does not clip the
 *   copy), a table line is that whole row or column.
 * - It is drawn in the body's styles: it carries the editor element's classes
 *   but the three BlockNote reads as an editor's, and `index.css` gives it the
 *   table rules that hang off those three.
 * - It is scaled as a whole so its longest side is 512px. Chrome draws the
 *   image in the root element's own space, leaving out the root's transform
 *   and opacity (`data_transfer.cc`, the same reason `index.css` puts the
 *   preview's opacity on a child), so the root takes the scaled size and the
 *   scale sits on the layer inside it.
 */

import type { EditorView } from '@tiptap/pm/view';

import type { DragOrientation } from '@web/spaces/document/document-table-drag';
import { cellAt } from '@web/spaces/document/document-table-run';

/** The longest side of every drag preview, in px (user 2026-10-10). */
export const PREVIEW_LONGEST_SIDE = 512;

/** A natural size, in px. */
export interface PreviewSize {
  readonly width: number;
  readonly height: number;
}

/** A preview attached to the page. */
export interface DragPreview {
  /** What to hand to `setDragImage`. */
  readonly element: HTMLElement;
  /** Takes it off the page. */
  readonly remove: () => void;
}

/** The class BlockNote gives its own drag preview, and ours takes for its positioning. */
const LIBRARY_PREVIEW_CLASS = 'bn-drag-preview';

/**
 * The editor element's classes the preview leaves off: BlockNote takes any
 * `.bn-editor` in the page for an editor and reads its block group, the drop's
 * routing included (`SideMenu.ts` `findClosestEditorElement`), and its own
 * preview drops these three (`dragging.ts`). What the table needs from them
 * is given to the preview in `index.css`.
 */
const EDITOR_ONLY_CLASSES = new Set(['bn-root', 'bn-editor', 'ProseMirror']);

/** A media block's box: the media and nothing around it. */
const MEDIA_BOX = '[data-media-box]';
/** The controls a media block draws over its media. */
const MEDIA_CHROME = '[data-media-chrome]';
/** The element a table scrolls sideways in. */
const SCROLL_VIEWPORT = '[data-radix-scroll-area-viewport]';
/** A table block. */
const TABLE_BLOCK = '[data-content-type="table"]';
/** The video readiness from which a frame can be drawn (`HAVE_CURRENT_DATA`). */
const HAVE_CURRENT_DATA = 2;

/**
 * The scale that brings the longest side to {@link PREVIEW_LONGEST_SIDE}.
 * @param width - The natural width.
 * @param height - The natural height.
 * @returns The scale; 1 for content with no size.
 */
export function previewScale(width: number, height: number): number {
  const longest = Math.max(width, height);
  return longest > 0 ? PREVIEW_LONGEST_SIDE / longest : 1;
}

/**
 * Measures a laid-out layer, overflow included.
 * @param layer - The layer.
 * @returns Its natural size.
 */
function measureLayer(layer: HTMLElement): PreviewSize {
  const box = layer.getBoundingClientRect();
  return { width: Math.max(box.width, layer.scrollWidth), height: Math.max(box.height, layer.scrollHeight) };
}

/**
 * Attaches a preview of some content to the page, scaled and in the body's
 * styles.
 * @param view - The editor view whose styles it takes.
 * @param content - The content, detached.
 * @param measure - Reads the content's natural size once laid out.
 * @returns The preview.
 */
export function buildDragPreview(
  view: EditorView,
  content: HTMLElement,
  measure: (layer: HTMLElement) => PreviewSize = measureLayer,
): DragPreview {
  const page = view.dom.ownerDocument;
  const root = page.createElement('div');
  root.className = LIBRARY_PREVIEW_CLASS;
  root.style.padding = '0';
  root.style.overflow = 'hidden';
  const layer = page.createElement('div');
  layer.className = [...view.dom.classList].filter((name) => !EDITOR_ONLY_CLASSES.has(name)).join(' ');
  layer.style.display = 'inline-block';
  layer.style.padding = '0';
  layer.style.transformOrigin = '0px 0px';
  layer.append(content);
  root.append(layer);
  page.body.append(root);
  const size = measure(layer);
  const scale = previewScale(size.width, size.height);
  root.style.width = `${size.width * scale}px`;
  root.style.height = `${size.height * scale}px`;
  layer.style.transform = `scale(${scale})`;
  return {
    element: root,
    remove: () => {
      root.remove();
    },
  };
}

/**
 * The body column's content width.
 * @param view - The editor view.
 * @returns The width, in px.
 */
function columnWidth(view: EditorView): number {
  const style = view.dom.ownerDocument.defaultView?.getComputedStyle(view.dom);
  const padding = (parseFloat(style?.paddingLeft ?? '') || 0) + (parseFloat(style?.paddingRight ?? '') || 0);
  return view.dom.clientWidth - padding;
}

/**
 * Turns copied content into what the preview shows: no media controls, no
 * scroll frame clipping a table, a still of each video.
 * @param view - The editor view, where the copied videos' originals are.
 * @param content - The copied content.
 */
function settle(view: EditorView, content: HTMLElement): void {
  content.querySelectorAll(MEDIA_CHROME).forEach((chrome) => {
    chrome.remove();
  });
  content.querySelectorAll<HTMLElement>(SCROLL_VIEWPORT).forEach((viewport) => {
    viewport.style.overflow = 'visible';
    if (viewport.parentElement !== null) viewport.parentElement.style.overflow = 'visible';
  });
  const originals = [...view.dom.querySelectorAll('video')];
  content.querySelectorAll('video').forEach((video) => {
    video.replaceWith(stillOf(video, originals));
  });
}

/**
 * A canvas the size of a copied video, holding its original's current frame.
 * A copied video starts loading from nothing, and the drag image is taken
 * before it has a frame.
 * @param copy - The copied video.
 * @param originals - The body's videos.
 * @returns The canvas.
 */
function stillOf(copy: HTMLVideoElement, originals: HTMLVideoElement[]): HTMLCanvasElement {
  const original = originals.find((video) => video.currentSrc !== '' && video.currentSrc === copy.currentSrc) ??
    originals.find((video) => video.getAttribute('src') !== null && video.getAttribute('src') === copy.getAttribute('src'));
  const box = original?.getBoundingClientRect();
  const canvas = copy.ownerDocument.createElement('canvas');
  canvas.width = Math.round(box?.width || copy.width || copy.clientWidth);
  canvas.height = Math.round(box?.height || copy.height || copy.clientHeight);
  canvas.className = copy.className;
  if (original !== undefined && original.readyState >= HAVE_CURRENT_DATA) {
    canvas.getContext('2d')?.drawImage(original, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

/**
 * What a row drag's preview shows, from the blocks BlockNote copied: a lone
 * media block is its media box; anything else is the blocks at the width of
 * the body column.
 * @param view - The editor view.
 * @param blocks - The copied blocks.
 * @returns The content, detached.
 */
export function blockPreviewContent(view: EditorView, blocks: readonly Element[]): HTMLElement {
  const page = view.dom.ownerDocument;
  const box = blocks.length === 1 && blocks[0]!.querySelector(TABLE_BLOCK) === null
    ? blocks[0]!.querySelector<HTMLElement>(MEDIA_BOX)
    : null;
  let content: HTMLElement;
  if (box !== null) {
    box.remove();
    content = box;
  } else {
    content = page.createElement('div');
    content.style.width = `${columnWidth(view)}px`;
    content.append(...blocks);
  }
  settle(view, content);
  return content;
}

/**
 * The child indices from an ancestor down to a node.
 * @param ancestor - The ancestor.
 * @param node - The node.
 * @returns The path.
 */
function pathTo(ancestor: Element, node: Element): number[] {
  const path: number[] = [];
  for (let at: Element = node; at !== ancestor && at.parentElement !== null; at = at.parentElement) {
    path.unshift([...at.parentElement.children].indexOf(at));
  }
  return path;
}

/**
 * Follows child indices down from a node.
 * @param from - The node.
 * @param path - The path.
 * @returns The node at its end.
 */
function follow(from: Element, path: readonly number[]): Element | undefined {
  return path.reduce<Element | undefined>((at, index) => at?.children[index], from);
}

/**
 * What a table row or column drag's preview shows: that whole line, inside a
 * copy of its table block so the table's styles and column widths hold. The
 * line's cells come from the table map, so a merged cell elsewhere does not
 * shift which cells are kept.
 * @param view - The editor view.
 * @param cellPos - A cell of the line.
 * @param orientation - Row or column.
 * @returns The content, detached; null when the position is not a cell.
 */
export function tableLinePreviewContent(
  view: EditorView,
  cellPos: number,
  orientation: DragOrientation,
): HTMLElement | null {
  const at = cellAt(view.state.doc, cellPos);
  if (at === null) return null;
  const rect =
    orientation === 'row'
      ? { left: 0, right: at.map.width, top: at.top, bottom: at.top + 1 }
      : { left: at.left, right: at.left + 1, top: 0, bottom: at.map.height };
  const cells = at.map
    .cellsInRect(rect)
    .map((rel) => view.nodeDOM(at.tableStart + rel))
    .filter((node): node is HTMLElement => node instanceof HTMLElement);
  const block = cells[0]?.closest(TABLE_BLOCK);
  if (block === null || block === undefined) return null;
  const copy = block.cloneNode(true) as HTMLElement;
  const kept = new Set(cells.map((cell) => follow(copy, pathTo(block, cell))));
  copy.querySelectorAll('td, th').forEach((cell) => {
    if (!kept.has(cell)) cell.remove();
  });
  copy.querySelectorAll('tr').forEach((row) => {
    if (row.querySelector('td, th') === null) row.remove();
  });
  if (orientation === 'column') {
    copy.querySelectorAll('colgroup').forEach((group) => {
      [...group.children].forEach((col, index) => {
        if (index !== at.left) col.remove();
      });
    });
    copy.querySelectorAll<HTMLElement>('table').forEach((table) => {
      table.style.width = 'auto';
      table.style.minWidth = '0';
    });
  }
  settle(view, copy);
  return copy;
}

/**
 * Replaces the preview BlockNote set for a row drag with ours, built from the
 * blocks BlockNote copied. Called in the same `dragstart`, after the library's
 * `blockDragStart`: each `setDragImage` replaces the last one
 * (`data_transfer.cc`).
 * @param view - The editor view.
 * @param dataTransfer - The drag's data transfer.
 * @returns Our preview, or null when the library put none in the page.
 */
export function previewRowDrag(view: EditorView, dataTransfer: DataTransfer | null): DragPreview | null {
  const library = [...view.dom.ownerDocument.querySelectorAll(`body > .${LIBRARY_PREVIEW_CLASS}`)].at(-1);
  if (library === undefined || dataTransfer === null) return null;
  const blocks = [...library.children].map((block) => block.cloneNode(true) as Element);
  const preview = buildDragPreview(view, blockPreviewContent(view, blocks));
  dataTransfer.setDragImage(preview.element, 0, 0);
  return preview;
}
