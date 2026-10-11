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
 *   table is its table alone, every column, out of the frame it scrolls in,
 *   a table line is that whole row or column.
 * - It is drawn in the body's styles: it carries the editor element's classes
 *   but the three BlockNote reads as an editor's, and `index.css` gives it the
 *   table rules that hang off those three.
 * - It is scaled down as a whole when a side is longer than 512px, until the
 *   longest is 512px; content no longer than that keeps its own size. Chrome
 *   draws the image in the root element's own space, leaving out the root's
 *   transform and opacity (`data_transfer.cc`, the same reason `index.css`
 *   puts the preview's opacity on a child), so the root takes the scaled size
 *   and the scale sits on the layer inside it.
 */

import type { EditorView } from '@tiptap/pm/view';

import { MEDIA_CHROME } from '@web/spaces/document/DocumentMediaBlock';
import type { DragOrientation } from '@web/spaces/document/document-table-drag';
import { cellAt, cellsOfScope } from '@web/spaces/document/document-table-run';

/** The longest a drag preview's side may be, in px (user 2026-10-10). */
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
/** A table block. */
const TABLE_BLOCK = '[data-content-type="table"]';
/** A block's content element, which carries the space above the block. */
const BLOCK_CONTENT = '.bn-block-content';
/** A block's own content, as against the blocks nested under it. */
const OWN_CONTENT = ':scope > .bn-block > .bn-block-content';
/** The group a block's nested blocks sit in. */
const NESTED_GROUP = ':scope > .bn-block > .bn-block-group';
/** BlockNote's group of blocks, the context its indent rules read. */
const BLOCK_GROUP_CLASS = 'bn-block-group';

/**
 * The scale that brings a longest side over {@link PREVIEW_LONGEST_SIDE} down to
 * it. It never enlarges: the browser clamps a drag image the same way, shrinking
 * only what is over its limit (Chromium `drag_image.cc` `ClampedImageScale`).
 * @param width - The natural width.
 * @param height - The natural height.
 * @returns The scale, at most 1.
 */
export function previewScale(width: number, height: number): number {
  const longest = Math.max(width, height);
  return longest > PREVIEW_LONGEST_SIDE ? PREVIEW_LONGEST_SIDE / longest : 1;
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
  // On the root's line an inline block sits on the baseline, below the line's
  // own ascent, and the root, cut to the scaled size, would clip its foot.
  layer.style.verticalAlign = 'top';
  layer.style.padding = '0';
  layer.style.transformOrigin = '0px 0px';
  layer.append(content);
  // The first block stands flush against the top, as the document's first block
  // does (`index.css`): the space every other block carries above it is the
  // gap to the block before, and the preview has none.
  layer.querySelector<HTMLElement>(BLOCK_CONTENT)?.style.setProperty('--doc-block-lift', '0px');
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
 * The element in the body a copied element was copied from: in the block with
 * the copy's block id, the one at the copy's place among the same kind.
 * @param view - The editor view.
 * @param copy - The copied element, still inside its copied block.
 * @param selector - What kind of element it is.
 * @returns The original, or null when the copy carries no block id.
 */
function originalOf(view: EditorView, copy: Element, selector: string): Element | null {
  const block = copy.closest('[data-id]');
  const id = block?.getAttribute('data-id');
  if (block === null || block === undefined || id === null || id === undefined) return null;
  const original = view.dom.querySelector(`[data-id="${id}"]`);
  const index = [...block.querySelectorAll(selector)].indexOf(copy);
  return original?.querySelectorAll(selector)[index] ?? null;
}

/**
 * Turns copied content into what the preview shows: no media toolbar, each
 * table as its table alone, a still of each video. Run while the copies are
 * still in their copied blocks, where their originals can be found.
 *
 * A table block holds its table inside the frame it scrolls in, and the frame
 * draws a scrollbar and the edges of what is scrolled off. The preview shows
 * every column, so none of that is true of it: the block keeps its table and
 * nothing else.
 * @param view - The editor view.
 * @param content - The copied content.
 */
function settle(view: EditorView, content: Element): void {
  content.querySelectorAll(MEDIA_CHROME).forEach((chrome) => {
    chrome.remove();
  });
  const tables = content.matches(TABLE_BLOCK) ? [content] : [];
  tables.push(...content.querySelectorAll(TABLE_BLOCK));
  tables.forEach((block) => {
    block.replaceChildren(...block.querySelectorAll('table'));
  });
  content.querySelectorAll('video').forEach((video) => {
    const original = originalOf(view, video, 'video');
    video.replaceWith(stillOf(video, original instanceof HTMLVideoElement ? original : null));
  });
}

/**
 * A canvas the size of a copied video, holding its original's current frame.
 * A copied video starts loading from nothing, and the drag image is taken
 * before it has a frame.
 * @param copy - The copied video.
 * @param original - The video it was copied from.
 * @returns The canvas.
 */
function stillOf(copy: HTMLVideoElement, original: HTMLVideoElement | null): HTMLCanvasElement {
  const box = original?.getBoundingClientRect();
  const canvas = copy.ownerDocument.createElement('canvas');
  canvas.width = Math.round(box?.width || copy.width || copy.clientWidth);
  canvas.height = Math.round(box?.height || copy.height || copy.clientHeight);
  canvas.className = copy.className;
  if (original !== null && original.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    canvas.getContext('2d')?.drawImage(original, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

/**
 * What a row drag's preview shows, from the blocks BlockNote copied: a lone
 * media block with nothing nested under it is its media box; anything else is
 * the blocks, in a block group at the width of the body column.
 *
 * Each copy carries what it had in the body: the width it is drawn at, and the
 * group its nested blocks' indent is read in.
 * @param view - The editor view.
 * @param blocks - The copied blocks.
 * @returns The content, detached.
 */
export function blockPreviewContent(view: EditorView, blocks: readonly Element[]): HTMLElement {
  const page = view.dom.ownerDocument;
  const lone = blocks.length === 1 ? blocks[0]! : null;
  const own = lone?.querySelector(OWN_CONTENT);
  const box =
    lone !== null && own !== null && own !== undefined && !own.matches(TABLE_BLOCK) &&
    lone.querySelector(NESTED_GROUP) === null
      ? own.querySelector<HTMLElement>(MEDIA_BOX)
      : null;
  if (box !== null) {
    // The box takes its width from the body's row (an audio fills it; any box
    // is held to it), and the preview wraps its content.
    const original = originalOf(view, box, MEDIA_BOX);
    if (original !== null) box.style.width = `${original.getBoundingClientRect().width}px`;
    settle(view, lone!);
    box.remove();
    return box;
  }
  const content = page.createElement('div');
  content.className = BLOCK_GROUP_CLASS;
  content.style.width = `${columnWidth(view)}px`;
  content.append(...blocks);
  settle(view, content);
  return content;
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
  const cells = cellsOfScope(view.state.doc, cellPos, orientation)
    .map((pos) => view.nodeDOM(pos))
    .filter((node): node is HTMLElement => node instanceof HTMLElement);
  const block = cells[0]?.closest(TABLE_BLOCK);
  if (block === null || block === undefined) return null;
  const copy = block.cloneNode(true) as HTMLElement;
  // The copy has the original's structure, so a cell is at its own place.
  const originals = [...block.querySelectorAll('td, th')];
  const copies = [...copy.querySelectorAll('td, th')];
  const kept = new Set(cells.map((cell) => copies[originals.indexOf(cell)]));
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
  // The line keeps the width it is drawn at in the body, its table's for a row
  // and its cell's for a column: the preview wraps its content, and a table
  // with no stored widths would lay out again to whatever width it is given.
  const drawn = orientation === 'row' ? block.querySelector('table') : cells[0];
  const width = drawn?.getBoundingClientRect().width ?? 0;
  if (width > 0) copy.style.width = `${width}px`;
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
