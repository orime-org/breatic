// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The image that follows the pointer while a row, a table line, what is
 * selected (whole blocks or cell rows) or a caption's words are dragged
 * (inner#1350 A1).
 *
 * Every preview is built here and nowhere else, because three things have to
 * hold for all of them at once:
 *
 * - It is measured on the dragged content itself: a text block has no width of
 *   its own and takes that of the group it sits in, a media block is its media
 *   box, a table is in the frame it scrolls in from its first column in view, a
 *   table row is that whole row in the same frame and a column is that column
 *   alone. Each builder says which element of the body its content is drawn
 *   as wide as (`PlacedContent.sizedLike`), and the content is laid out at
 *   that width here. A table keeps the widths and heights the body draws its
 *   columns and rows at.
 * - It is drawn in the body's styles: its content sits in copies of the
 *   elements it sits in in the body, which lay out and draw nothing of their
 *   own (`document-preview-styles.ts`).
 * - It is scaled down as a whole when a side is longer than 512px, until the
 *   longest is 512px; content no longer than that keeps its own size. Chrome
 *   draws the image in the root element's own space, leaving out the root's
 *   transform (`data_transfer.cc`), so the root takes the scaled size and the
 *   scale sits on the layer inside it.
 *
 * The root is opaque and fixed at the viewport's top left (`index.css`):
 * Firefox and WebKit draw the root's own opacity into the image, and Safari
 * cancels a drag whose image is wholly off screen. The browser takes the image
 * while `dragstart` is dispatched, so the root leaves the page in the next
 * animation frame, before that frame is painted, or at the drag's next event
 * if that comes first (inner#1350 design §4).
 */

import type { EditorView } from '@tiptap/pm/view';

import { SCROLLBAR_MARK } from '@web/components/ui/scroll-area';
import { MEDIA_CHROME } from '@web/spaces/document/DocumentMediaBlock';
import type { DragOrientation } from '@web/spaces/document/document-table-drag';
import { cellAt, cellsOfScope } from '@web/spaces/document/document-table-run';
import { QUOTE_RUN_ATTRIBUTES } from '@web/spaces/document/document-decorations';
import { inPlaceOf } from '@web/spaces/document/document-preview-styles';

/** The longest a drag preview's side may be, in px (user 2026-10-10). */
export const PREVIEW_LONGEST_SIDE = 512;

/** A natural size, in px. */
export interface PreviewSize {
  readonly width: number;
  readonly height: number;
}

/** Content copied out of the body for a drag preview, and where it stands there. */
export interface PlacedContent {
  /** The copied content. */
  readonly content: HTMLElement;
  /** The element it takes the place of; null when it sits where the body's own block group does. */
  readonly place: Element | null;
  /** The element it is drawn as wide as; null when the body has none to go by. */
  readonly sizedLike: Element | null;
}

/** The class `index.css` places and styles every preview by. */
const PREVIEW_CLASS = 'doc-drag-preview';

/** A scroll frame's scrollbar (`components/ui/scroll-area`). */
const SCROLLBAR = `[${SCROLLBAR_MARK}]`;

/** A table's scroll frame, the part that scrolls. */
const SCROLL_VIEWPORT = '[data-radix-scroll-area-viewport]';

/** A media block's box: the media and nothing around it. */
const MEDIA_BOX = '[data-media-box]';
/** A table block. */
const TABLE_BLOCK = '[data-content-type="table"], [data-node-type="docTable"]';

/** The wrapper `DocumentTableScroller` draws around a table's `<table>` (`mountScroller` in `document-table-nodes.tsx`). */
const TABLE_WRAPPER = '.tableWrapper';
/** The edges of a table's frame that say columns run on (`DocumentTableScroller`). */
const OVERFLOW_EDGE = '.doc-table-overflow-edge';
/** The frame a table scrolls in, with its edges. */
const TABLE_FRAME = '.doc-table-frame';
/** A block's content element, which carries the space above the block. */
const BLOCK_CONTENT = '.bn-block-content';
/** A block's own content, as against the blocks nested under it. */
const OWN_CONTENT = ':scope > .bn-block > .bn-block-content';
/** The group a block's nested blocks sit in. */
const NESTED_GROUP = ':scope > .bn-block > .bn-block-group';
/** BlockNote's group of blocks, the context its indent rules read. */
const BLOCK_GROUP_CLASS = 'bn-block-group';
/** A block in the body, with the blocks nested under it. */
const ROW = '.bn-block-outer';

/**
 * The element a block with an id is drawn in: a block's row, or a table's
 * own frame, which holds its rows and stands for the block (inner#1619).
 * @param id - The block's id.
 * @returns The selector.
 */
function rowWithId(id: string): string {
  return `${ROW}[data-id="${id}"], [data-node-type="docTable"][data-id="${id}"]`;
}

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

/** Elements that draw what they hold whatever their style says. */
const REPLACED = new Set(['img', 'video', 'canvas', 'svg', 'iframe', 'input', 'hr']);

/**
 * Whether an element paints a box of its own: a background or a border.
 * @param style - Its computed style.
 * @returns True when it does.
 */
function paintsBox(style: CSSStyleDeclaration): boolean {
  if (style.backgroundImage !== '' && style.backgroundImage !== 'none') return true;
  const background = style.backgroundColor;
  if (background !== '' && background !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(background)) return true;
  return (['Top', 'Right', 'Bottom', 'Left'] as const).some(
    (side) => parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== 'none',
  );
}

/**
 * Measures a laid-out layer by what it draws: its words, its pictures, the
 * boxes that paint a background or a border, each cut to the boxes that clip
 * it. A block is laid out as wide as the body's column, so its lines break as
 * they do there, and the room past its words is drawn as nothing; counted, it
 * would scale a short line down with the column (A1: the longest side of what
 * is dragged). Its height is the layer's.
 * @param layer - The layer.
 * @returns Its natural size.
 */
export function measureDrawn(layer: HTMLElement): PreviewSize {
  const page = layer.ownerDocument;
  const frame = page.defaultView ?? window;
  const box = layer.getBoundingClientRect();
  let right = box.left;
  /**
   * Takes in how far a node and what it holds draw.
   * @param node - The node.
   * @param clip - The right edge of the boxes clipping it.
   */
  const visit = (node: Node, clip: number): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.textContent ?? '').trim() === '') return;
      const range = page.createRange();
      range.selectNodeContents(node);
      right = Math.max(right, Math.min(range.getBoundingClientRect().right, clip));
      return;
    }
    if (!(node instanceof Element)) return;
    const style = frame.getComputedStyle(node);
    if (style.display === 'none') return;
    // An element that is no box (the copies a preview's content sits in)
    // neither clips, paints nor fades what it holds.
    if (style.display === 'contents') {
      node.childNodes.forEach((child) => visit(child, clip));
      return;
    }
    if (style.opacity === '0' || style.visibility === 'hidden') return;
    const rect = node.getBoundingClientRect();
    if (REPLACED.has(node.localName) || paintsBox(style)) right = Math.max(right, Math.min(rect.right, clip));
    const inner = style.overflowX === 'visible' ? clip : Math.min(clip, rect.right);
    node.childNodes.forEach((child) => visit(child, inner));
  };
  layer.childNodes.forEach((child) => visit(child, Infinity));
  const width = right > box.left ? right - box.left : Math.max(box.width, layer.scrollWidth);
  return { width, height: Math.max(box.height, layer.scrollHeight) };
}

/** A drag's events, each dispatched once the browser has taken the image. */
const DRAG_EVENTS = ['drag', 'dragenter', 'dragover', 'dragleave', 'drop', 'dragend'] as const;

/**
 * Takes a preview off the page once the browser has its image: in the next
 * animation frame, before it is painted, or at the drag's next event if that
 * comes first. Until then the preview's copy of the editor element is on the
 * page, where BlockNote looks for an editor on the drag's events
 * (`SideMenu.ts` `findClosestEditorElement`); the window sees each first, in
 * the capture phase.
 * @param root - The preview's root.
 */
function leaveOnceTaken(root: HTMLElement): void {
  const frame = root.ownerDocument.defaultView ?? window;
  /** Takes the preview off the page, and what would take it off again. */
  const leave = (): void => {
    frame.cancelAnimationFrame(next);
    DRAG_EVENTS.forEach((type) => frame.removeEventListener(type, leave, true));
    root.remove();
  };
  const next = frame.requestAnimationFrame(leave);
  DRAG_EVENTS.forEach((type) => frame.addEventListener(type, leave, true));
}

/**
 * Attaches a preview of some content to the page, scaled and in the body's
 * styles, for the `dragstart` being dispatched to hand to `setDragImage`. It
 * takes itself off the page once the browser has the image.
 * @param view - The editor view whose styles it takes.
 * @param placed - The content, detached, and where it stands in the body.
 * @param measure - Reads the content's natural size once laid out.
 * @returns The preview's root, the element to hand to `setDragImage`.
 */
export function buildDragPreview(
  view: EditorView,
  placed: PlacedContent,
  measure: (layer: HTMLElement) => PreviewSize = measureDrawn,
): HTMLElement {
  const page = view.dom.ownerDocument;
  const { content } = placed;
  // The first block stands flush against the top and the last against the
  // bottom, as the document's do (`index.css`): the space a block carries above
  // or below it is the gap to its neighbour, and the preview has none past its
  // ends. A quote's rule reaches over the same two spaces, so it ends at the
  // words there too.
  const blocks = content.matches(BLOCK_CONTENT)
    ? [content, ...content.querySelectorAll<HTMLElement>(BLOCK_CONTENT)]
    : [...content.querySelectorAll<HTMLElement>(BLOCK_CONTENT)];
  blocks[0]?.style.setProperty('--doc-block-lift', '0px');
  blocks[blocks.length - 1]?.style.setProperty('--doc-block-drop', '0px');
  const width = placed.sizedLike?.getBoundingClientRect().width ?? 0;
  if (width > 0) content.style.width = `${width}px`;
  const root = page.createElement('div');
  root.className = PREVIEW_CLASS;
  root.style.overflow = 'hidden';
  const layer = page.createElement('div');
  layer.style.display = 'inline-block';
  // On the root's line an inline block sits on the baseline, below the line's
  // own ascent, and the root, cut to the scaled size, would clip its foot.
  layer.style.verticalAlign = 'top';
  layer.style.padding = '0';
  layer.style.transformOrigin = '0px 0px';
  layer.append(inPlaceOf(view, content, placed.place));
  root.append(layer);
  page.body.append(root);
  const size = measure(layer);
  const scale = previewScale(size.width, size.height);
  root.style.width = `${size.width * scale}px`;
  root.style.height = `${size.height * scale}px`;
  layer.style.transform = `scale(${scale})`;
  leaveOnceTaken(root);
  return root;
}

/**
 * Hands the browser a preview of some content, in the `dragstart` being
 * dispatched, its top left at the pointer (BlockNote `dragging.ts`).
 * @param view - The editor view.
 * @param dataTransfer - The drag's data transfer.
 * @param placed - The content, detached, and where it stands in the body.
 */
export function setDragPreview(view: EditorView, dataTransfer: DataTransfer, placed: PlacedContent): void {
  dataTransfer.setDragImage(buildDragPreview(view, placed), 0, 0);
}

/** The custom property a quoted line's rule is placed by (`document-decorations.ts`). */
const QUOTE_DEPTH = '--quote-depth';
/** A quoted line's content element. */
const QUOTED_LINE = '[data-quoted-run]';

/**
 * How deep a block sits in the body: the block groups around it but the body's
 * own.
 * @param view - The editor view.
 * @param original - The block's element in the body.
 * @returns The depth, 0 at the top.
 */
function nestingOf(view: EditorView, original: Element): number {
  let groups = 0;
  for (let at = original.parentElement; at !== null && at !== view.dom; at = at.parentElement) {
    if (at.classList.contains(BLOCK_GROUP_CLASS)) groups += 1;
  }
  return Math.max(0, groups - 1);
}

/** The columns a cell spans: its first, and the one after its last. */
type Span = readonly [number, number];

/**
 * The columns each cell of a table spans, read off its rows the way a table
 * map is: a cell merged down from a row above holds its columns in the rows
 * below.
 * @param table - The table.
 * @returns Each cell's columns.
 */
function spansOf(table: Element): Map<Element, Span> {
  const spans = new Map<Element, Span>();
  const heldUntil: number[] = [];
  [...table.querySelectorAll('tr')].forEach((row, at) => {
    let column = 0;
    row.querySelectorAll<HTMLTableCellElement>(':scope > td, :scope > th').forEach((cell) => {
      while ((heldUntil[column] ?? 0) > at) column += 1;
      spans.set(cell, [column, column + cell.colSpan]);
      for (let held = column; held < column + cell.colSpan; held += 1) heldUntil[held] = at + cell.rowSpan;
      column += cell.colSpan;
    });
  });
  return spans;
}

/**
 * How many of a table's columns, from its first, its frame has scrolled
 * wholly out of view on the left: every column up to the last whose right edge
 * some cell, in whichever row, draws at or left of the frame's edge. A cell
 * the frame's edge cuts through is in view.
 * @param table - The table in the body.
 * @returns The number of columns.
 */
function columnsScrolledOff(table: Element | null | undefined): number {
  const viewport = table?.closest(SCROLL_VIEWPORT);
  if (table === null || table === undefined || viewport === null || viewport === undefined || viewport.scrollLeft === 0) {
    return 0;
  }
  const edge = viewport.getBoundingClientRect().left + 0.5;
  let off = 0;
  spansOf(table).forEach(([, end], cell) => {
    if (cell.getBoundingClientRect().right <= edge) off = Math.max(off, end);
  });
  return off;
}

/**
 * The widths a table's columns are drawn at in the body, read off a cell that
 * spans that column alone: WebKit gives a `col` no box. 0 for a column every
 * cell of which spans others too.
 * @param table - The table in the body.
 * @returns One width per column.
 */
function columnWidths(table: Element | null | undefined): number[] {
  if (table === null || table === undefined) return [];
  const widths: number[] = [];
  let count = 0;
  spansOf(table).forEach(([first, end], cell) => {
    count = Math.max(count, end);
    if (end === first + 1 && widths[first] === undefined) widths[first] = cell.getBoundingClientRect().width;
  });
  return Array.from({ length: count }, (_, column) => widths[column] ?? 0);
}

/**
 * The height each row of a copied table is drawn at in the body, from the
 * table it was copied from. Run while the copy still has its original's rows.
 * @param original - The table in the body.
 * @param copy - Its copy.
 * @returns Each copied row's height.
 */
function copiedHeights(original: Element | null | undefined, copy: Element | null): Map<Element, number> {
  if (original === null || original === undefined || copy === null) return new Map();
  const rows = [...original.querySelectorAll('tr')];
  return new Map([...copy.querySelectorAll('tr')].map((row, index) => [row, rows[index]?.getBoundingClientRect().height ?? 0]));
}

/**
 * The columns each cell of a copied table spans, from the table it was copied
 * from. Run while the copy still has its original's cells.
 * @param original - The table in the body.
 * @param copy - Its copy.
 * @returns Each copied cell's columns.
 */
function copiedSpans(original: Element | null | undefined, copy: Element | null): Map<Element, Span> {
  if (original === null || original === undefined || copy === null) return new Map();
  const from = spansOf(original);
  const originals = [...from.keys()];
  const spans = new Map<Element, Span>();
  copy.querySelectorAll('td, th').forEach((cell, index) => {
    const span = from.get(originals[index]!);
    if (span !== undefined) spans.set(cell, span);
  });
  return spans;
}

/**
 * Takes a copied table's first columns out: their `col`s and their cells, and
 * from a cell merged across one of them, that column. The table
 * then starts at the first column in view, unscrolled. Chromium takes a drag
 * image as the box of the element handed over joined with every descendant
 * that has a layer of its own, whether clipped or not, and anchors the
 * pointer at that box's top left (`data_transfer.cc`
 * `DraggedNodeImageBuilder`, `layout_object.cc` `AddAbsoluteRectForLayer`):
 * cells scrolled off to the left would put the preview that far from the
 * pointer. Taken out rather than hidden by a style: WebKit draws a column set
 * to `visibility: collapse`.
 *
 * The frame's left edge says columns lie to the left. With none taken out, the
 * first column is drawn whole, so nothing does, and the edge goes too.
 * @param table - The copied table.
 * @param off - How many columns to take out, from the first.
 * @param spans - Each copied cell's columns.
 */
function dropColumns(table: Element | null | undefined, off: number, spans: ReadonlyMap<Element, Span>): void {
  if (table === null || table === undefined) return;
  if (off === 0) {
    table.closest(TABLE_FRAME)?.querySelector(`${OVERFLOW_EDGE}[data-overflow-edge="left"]`)?.removeAttribute('data-on');
    return;
  }
  table.querySelectorAll('col').forEach((col, index) => {
    if (index < off) col.remove();
  });
  table.querySelectorAll<HTMLTableCellElement>('td, th').forEach((cell) => {
    const span = spans.get(cell);
    if (span === undefined) return;
    const kept = span[1] - Math.max(span[0], off);
    if (kept <= 0) cell.remove();
    else if (kept !== cell.colSpan) cell.colSpan = kept;
  });
}

/**
 * The row in the body a copied row was copied from.
 * @param view - The editor view.
 * @param copy - The copied row.
 * @returns The original, or null when the copy carries no block id.
 */
function originalRow(view: EditorView, copy: Element): Element | null {
  const id = copy.getAttribute('data-id');
  return id === null ? null : view.dom.querySelector(rowWithId(id));
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
 * Turns copied content into what the preview shows: no media toolbar, no
 * scrollbar, a still of each video. Run while the copies are still in their
 * copied blocks, where their originals can be found. What the body shows for
 * the moment comes off where the preview is built (`inPlaceOf`).
 *
 * A table stays in the frame it scrolls in, as the body shows it: a table
 * wider than the column would otherwise set the preview's width, and scaled to
 * 512px the rest would be too small to read. The frame's scrollbar shows only
 * while the pointer is over it or it scrolls, so it is the moment's, not the
 * content's; the edges that say columns run on are drawn at rest, and stay,
 * except the left one when no column is taken out (`dropColumns`).
 *
 * The copy is the top of the preview, out of the groups it is nested in in the
 * body. A quoted line pulls its rule back over its own indent
 * (`[data-quoted-run]` in `index.css`), so every line counts its indent from
 * the copy's top: the rule stands beside the copy as beside a block at the top
 * of the body, rather than past the preview's left edge.
 * @param view - The editor view.
 * @param content - The copied content.
 * @param original - The element in the body the copy's top was copied from.
 */
function settle(view: EditorView, content: Element, original: Element | null): void {
  const base = original === null ? 0 : nestingOf(view, original);
  [content, ...content.querySelectorAll(QUOTED_LINE)].forEach((line) => {
    if (!(line instanceof HTMLElement) || !line.matches(QUOTED_LINE)) return;
    const depth = Number(line.style.getPropertyValue(QUOTE_DEPTH)) || 0;
    line.style.setProperty(QUOTE_DEPTH, String(Math.max(0, depth - base)));
  });
  content.querySelectorAll(MEDIA_CHROME).forEach((chrome) => {
    chrome.remove();
  });
  content.querySelectorAll(SCROLLBAR).forEach((scrollbar) => {
    scrollbar.remove();
  });
  content.querySelectorAll('video').forEach((video) => {
    const original = originalOf(view, video, 'video');
    video.replaceWith(stillOf(video, original instanceof HTMLVideoElement ? original : null));
  });
}

/**
 * A canvas the size of a copied video's original, holding its current frame
 * at the screen's pixels, as the body draws the video: the browser draws a
 * drag image at the screen's pixels too. Its size on the page is the video's,
 * from the classes it takes over. A copied video starts loading from nothing,
 * and the drag image is taken before it has a frame.
 * @param copy - The copied video.
 * @param original - The video it was copied from.
 * @returns The canvas.
 */
function stillOf(copy: HTMLVideoElement, original: HTMLVideoElement | null): HTMLCanvasElement {
  const box = original?.getBoundingClientRect();
  const canvas = copy.ownerDocument.createElement('canvas');
  const pixels = copy.ownerDocument.defaultView?.devicePixelRatio ?? 1;
  canvas.width = Math.round((box?.width ?? 0) * pixels);
  canvas.height = Math.round((box?.height ?? 0) * pixels);
  canvas.className = copy.className;
  if (original !== null && original.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    canvas.getContext('2d')?.drawImage(original, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

/**
 * What a row drag's preview shows, from the blocks BlockNote copied: a lone
 * media block with nothing nested under it is its media box; anything else is
 * the blocks, in a block group at the width of the group the first of them
 * sits in.
 *
 * Each copy carries what it had in the body: the width of the group it sits in,
 * and the group its nested blocks' indent is read in.
 * @param view - The editor view.
 * @param blocks - The copied blocks.
 * @returns The content, detached.
 */
export function blockPreviewContent(view: EditorView, blocks: readonly Element[]): PlacedContent {
  const page = view.dom.ownerDocument;
  const lone = blocks.length === 1 ? blocks[0]! : null;
  const own = lone?.querySelector(OWN_CONTENT);
  const box =
    lone !== null && own !== null && own !== undefined && !own.matches(TABLE_BLOCK) &&
    lone.querySelector(NESTED_GROUP) === null
      ? own.querySelector<HTMLElement>(MEDIA_BOX)
      : null;
  if (box !== null) {
    // The box is drawn as wide as in the body, where its row may give it its
    // width (an audio fills it), and the preview wraps its content.
    const original = originalOf(view, box, MEDIA_BOX);
    settle(view, lone!, originalRow(view, lone!));
    box.remove();
    return { content: box, place: original, sizedLike: original };
  }
  blocks.forEach((block) => {
    const originals = [...(originalRow(view, block)?.querySelectorAll('table') ?? [])];
    block.querySelectorAll('table').forEach((table, index) => {
      const original = originals[index];
      const off = columnsScrolledOff(original);
      const heights = copiedHeights(original, table);
      dropColumns(table, off, copiedSpans(original, table));
      holdTable(table, columnWidths(original).slice(off), heights);
    });
  });
  const original = blocks[0] === undefined ? null : originalRow(view, blocks[0]);
  const content = page.createElement('div');
  content.className = BLOCK_GROUP_CLASS;
  content.append(...blocks);
  settle(view, content, original);
  return { content, place: null, sizedLike: original?.parentElement ?? null };
}

/**
 * Holds a copied table at the geometry its original is drawn at: each row at
 * its height, each kept column at its own width, the table at their sum and no
 * wider, laid out to them. Laid out again from what the copy keeps, a row or a
 * column would share its room out another way, a row the columns taken out
 * leave empty would close up under the cell merged across it, and the width
 * prosemirror-tables writes on the table for all its columns
 * (`updateColumnsOnResize`) would stretch the ones kept. Written on the table
 * and its columns, so a quoted block's rule stands outside them as in the
 * body. Important, as the editor's own rule for a table's width is
 * (`.bn-editor [data-content-type=table] table`).
 * @param table - The copied table.
 * @param widths - The kept columns' widths in the body, in order.
 * @param heights - Each copied row's height in the body.
 */
function holdTable(table: HTMLElement | null | undefined, widths: readonly number[], heights: ReadonlyMap<Element, number>): void {
  if (table === null || table === undefined) return;
  table.querySelectorAll<HTMLElement>('tr').forEach((row) => {
    const height = heights.get(row) ?? 0;
    if (height > 0) row.style.height = `${height}px`;
  });
  const cols = [...table.querySelectorAll<HTMLElement>('col')];
  if (widths.length === 0 || widths.some((width) => width <= 0) || cols.length !== widths.length) return;
  cols.forEach((col, index) => col.style.setProperty('width', `${widths[index]}px`, 'important'));
  table.style.setProperty('width', `${widths.reduce((sum, width) => sum + width, 0)}px`, 'important');
  table.style.setProperty('min-width', '0px', 'important');
  table.style.setProperty('table-layout', 'fixed', 'important');
}

/**
 * Ends a row's or a cell selection's frame at its table: the room the
 * table's wrapper keeps under the table is for the frame's scrollbar, which
 * the preview does not draw, and with it a quote's rule would run on past the
 * rows (design §4). The frame's edges end at the table with it.
 * @param copy - The copied table block.
 */
function fitFrame(copy: HTMLElement): void {
  copy.querySelectorAll<HTMLElement>(TABLE_WRAPPER).forEach((wrapper) => {
    wrapper.style.padding = '0';
  });
  copy.querySelectorAll<HTMLElement>(OVERFLOW_EDGE).forEach((edge) => {
    edge.style.bottom = '0';
  });
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
): PlacedContent | null {
  const at = cellAt(view.state.doc, cellPos);
  if (at === null) return null;
  const cells = cellsOfScope(view.state.doc, cellPos, orientation)
    .map((pos) => view.nodeDOM(pos))
    .filter((node): node is HTMLElement => node instanceof HTMLElement);
  const block = cells[0]?.closest(TABLE_BLOCK);
  if (block === null || block === undefined) return null;
  const table = block.querySelector('table');
  const copy = block.cloneNode(true) as HTMLElement;
  const copied = copy.querySelector<HTMLElement>('table');
  // The copy has the original's structure, so a cell is at its own place.
  const originals = [...block.querySelectorAll('td, th')];
  const copies = [...copy.querySelectorAll('td, th')];
  const spans = copiedSpans(table, copied);
  const heights = copiedHeights(table, copied);
  const kept = new Set(cells.map((cell) => copies[originals.indexOf(cell)]));
  copy.querySelectorAll('td, th').forEach((cell) => {
    if (!kept.has(cell)) cell.remove();
  });
  // The rows the line's cells reach down through stay, one a merged cell
  // covers too, empty, for that cell to span it as in the body.
  const rows = [...copy.querySelectorAll('tr')];
  let first = rows.length;
  let last = -1;
  rows.forEach((row, index) => {
    row.querySelectorAll<HTMLTableCellElement>('td, th').forEach((cell) => {
      first = Math.min(first, index);
      last = Math.max(last, index + cell.rowSpan - 1);
    });
  });
  rows.forEach((row, index) => {
    if (index < first || index > last) row.remove();
  });
  const widths = columnWidths(table);
  if (orientation === 'column') {
    // A column is narrower than its frame, so the frame has nothing to scroll.
    // The table stays in its wrapper, a block as in the body: in
    // WebKit a collapsed table of a set width laid out as a flex item, which
    // the block's content is, is 1px wider. The room the wrapper keeps under
    // the table is for the frame's scrollbar. The block is as wide as the
    // column, which its cells are. A quote's rule stands beside the whole
    // block, not beside one of its columns.
    const wrappers = [...copy.querySelectorAll<HTMLElement>(TABLE_WRAPPER)];
    wrappers.forEach((wrapper) => {
      wrapper.style.padding = '0';
    });
    copy.replaceChildren(...wrappers);
    QUOTE_RUN_ATTRIBUTES.forEach((name) => copy.removeAttribute(name));
    copy.querySelectorAll('colgroup').forEach((group) => {
      [...group.children].forEach((col, index) => {
        if (index !== at.left) col.remove();
      });
    });
    holdTable(copied, [widths[at.left] ?? 0], heights);
  } else {
    const off = columnsScrolledOff(table);
    dropColumns(copied, off, spans);
    holdTable(copied, widths.slice(off), heights);
    fitFrame(copy);
  }
  settle(view, copy, block);
  // A table row is drawn as wide as the `.bn-block` its table block sits in,
  // which a quote's negative margin does not widen; a column as its own cells.
  return { content: copy, place: block, sizedLike: orientation === 'column' ? cells[0]! : block.parentElement };
}

/**
 * What a cell selection's preview shows: every column of the rows its cells
 * are in, inside a copy of its table block. A cell merged across those rows'
 * edges is cut to them the way the drag's own content is
 * (prosemirror-tables `CellSelection.content()`): one that starts above them is
 * an empty cell of the size it has within them, one that starts in them keeps
 * its words and is cut at their bottom. Its columns are not cut to the
 * selection: the rows are drawn across every column from the first one the
 * frame shows (`dropColumns`), as a table is.
 * @param view - The editor view.
 * @param cellPos - A cell of the table.
 * @param top - The first row, by the table map.
 * @param bottom - The row after the last one.
 * @returns The content, detached; null when the position is not a cell.
 */
export function tableRowsPreviewContent(
  view: EditorView,
  cellPos: number,
  top: number,
  bottom: number,
): PlacedContent | null {
  const at = cellAt(view.state.doc, cellPos);
  if (at === null) return null;
  const { map, tableStart } = at;
  const block = (view.nodeDOM(cellPos) as Element | null)?.closest(TABLE_BLOCK);
  if (block === null || block === undefined) return null;
  const table = block.querySelector('table');
  const copy = block.cloneNode(true) as HTMLElement;
  const copied = copy.querySelector<HTMLElement>('table');
  const heights = copiedHeights(table, copied);
  // The copy has the original's structure, so a cell is at its own place.
  const originals = [...block.querySelectorAll('td, th')];
  const copies = [...copy.querySelectorAll('td, th')];
  const rows = [...copy.querySelectorAll('tr')];
  const seen = new Set<number>();
  const spans = new Map<Element, Span>();
  rows.forEach((row, index) => {
    if (index < top || index >= bottom) {
      row.remove();
      return;
    }
    const cells: Element[] = [];
    for (let col = 0; col < map.width; col += 1) {
      const pos = map.map[index * map.width + col]!;
      if (seen.has(pos)) continue;
      seen.add(pos);
      const rect = map.findCell(pos);
      const drawn = copies[originals.indexOf(view.nodeDOM(tableStart + pos) as Element)];
      if (drawn === undefined) continue;
      const cell = rect.top < top ? (drawn.cloneNode(false) as Element) : drawn;
      const span = Math.min(rect.bottom, bottom) - Math.max(rect.top, top);
      if (span > 1) cell.setAttribute('rowspan', String(span));
      else cell.removeAttribute('rowspan');
      spans.set(cell, [rect.left, rect.right]);
      cells.push(cell);
    }
    row.replaceChildren(...cells);
  });
  const off = columnsScrolledOff(table);
  dropColumns(copied, off, spans);
  holdTable(copied, columnWidths(table).slice(off), heights);
  fitFrame(copy);
  settle(view, copy, block);
  return { content: copy, place: block, sizedLike: block.parentElement };
}

/**
 * What a drag of a caption field's words shows: the whole field, holding what
 * it holds now, at the width it is drawn at and without the space above it.
 * It is not a block, so nothing in it is the media chrome `settle` takes out.
 * @param input - The caption field.
 * @returns The content, detached.
 */
export function captionPreviewContent(input: HTMLInputElement): PlacedContent {
  const copy = input.cloneNode(true) as HTMLInputElement;
  copy.style.marginTop = '0px';
  return { content: copy, place: input, sizedLike: input };
}

/**
 * Replaces the preview BlockNote set for a row drag with ours: the row whose
 * handle was pressed, copied from the body. The library copies every block a
 * selection spans, and the drop moves the pressed row alone
 * (`document-drag-drop.ts`). Called in the same `dragstart`, after the
 * library's `blockDragStart`: each `setDragImage` replaces the last one
 * (`data_transfer.cc`).
 * @param view - The editor view.
 * @param dataTransfer - The drag's data transfer.
 * @param blockId - The row.
 */
export function previewRowDrag(view: EditorView, dataTransfer: DataTransfer | null, blockId: string): void {
  const row = view.dom.querySelector(rowWithId(blockId));
  if (row === null || !dataTransfer) return;
  setDragPreview(view, dataTransfer, blockPreviewContent(view, [row.cloneNode(true) as Element]));
}
