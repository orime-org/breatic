// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1350 A1: every drag preview is the dragged content itself, drawn in
 * the body's styles, scaled down as a whole so its longest side is at most
 * 512px
 * (design §4).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  PREVIEW_LONGEST_SIDE,
  blockPreviewContent,
  buildDragPreview,
  measureDrawn,
  setDragPreview,
  previewScale,
  tableLinePreviewContent,
  tableRowsPreviewContent,
} from '@web/spaces/document/document-drag-preview';
import { QUOTE_RUN_ATTRIBUTES } from '@web/spaces/document/document-decorations';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * Opens an editor holding the blocks given.
 * @param blocks - The blocks.
 * @returns The editor.
 */
function open(blocks: unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  // The surface sits inside a container, as the Space page puts it
  // (`adoptDocumentEditor`); the preview goes on the page body, outside it.
  const container = document.createElement('div');
  const host = document.createElement('div');
  container.appendChild(host);
  document.body.appendChild(container);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * Where a cell holding some text starts.
 * @param editor - The editor.
 * @param text - The text.
 * @returns The position before the cell.
 */
function cellOf(editor: Editor, text: string): number {
  let at = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === 'tableCell' && node.textContent === text) at = pos;
    return at < 0;
  });
  return at;
}

/**
 * The texts of a preview's cells, row by row.
 * @param content - The preview content.
 * @returns The texts.
 */
function cellTexts(content: HTMLElement): string[][] {
  return [...content.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('td, th')].map((c) => c.textContent ?? ''));
}

/**
 * A block as BlockNote draws it: its own content, and the blocks nested under
 * it in a group.
 * @param id - Its id.
 * @param type - Its content type.
 * @param inner - The inside of its content.
 * @param children - Its nested blocks, as HTML.
 * @returns The block.
 */
function blockOf(id: string, type: string, inner: string, children?: string): HTMLElement {
  const block = document.createElement('div');
  block.className = 'bn-block-outer';
  block.setAttribute('data-id', id);
  block.innerHTML =
    `<div class="bn-block"><div class="bn-block-content" data-content-type="${type}">${inner}</div>` +
    (children === undefined ? '' : `<div class="bn-block-group">${children}</div>`) +
    '</div>';
  return block;
}

/**
 * Lays a table out in the body as given: each cell's left and right edges,
 * found by its text, and each row's height.
 * @param editor - The editor.
 * @param edges - Each cell's left and right, by its text.
 * @param heights - Each row's height, in order.
 */
function layOut(editor: Editor, edges: Record<string, [number, number]>, heights: number[] = []): void {
  const view = editor.prosemirrorView!;
  view.dom.querySelectorAll<HTMLElement>('td, th').forEach((cell) => {
    const [left, right] = edges[cell.textContent ?? ''] ?? [0, 0];
    cell.getBoundingClientRect = () => ({ left, right, width: right - left, top: 0, bottom: 30, height: 30 }) as DOMRect;
  });
  view.dom.querySelectorAll<HTMLElement>('tr').forEach((row, index) => {
    row.getBoundingClientRect = () => ({ height: heights[index] ?? 0 }) as DOMRect;
  });
}

/**
 * Scrolls a table's frame to the left by some amount, its left edge at 100.
 * @param editor - The editor.
 * @param by - How far.
 */
function scrollFrame(editor: Editor, by: number): void {
  const viewport = editor.prosemirrorView!.dom.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]')!;
  viewport.scrollLeft = by;
  viewport.getBoundingClientRect = () => ({ left: 100, right: 400, width: 300, height: 90 }) as DOMRect;
}

/**
 * How a preview's table is held: its columns' widths, its own width, minimum
 * width and layout, and its rows' heights.
 * @param content - The preview content.
 * @returns What is written on them.
 */
function heldTable(content: HTMLElement): unknown {
  const table = content.querySelector<HTMLElement>('table')!;
  return {
    cols: [...content.querySelectorAll<HTMLElement>('col')].map((col) => col.style.width),
    table: [table.style.width, table.style.minWidth, table.style.tableLayout],
    rows: [...content.querySelectorAll<HTMLElement>('tr')].map((row) => row.style.height),
  };
}

describe('previewScale', () => {
  it('fits the width to 512 when the content is wider than tall', () => {
    expect(previewScale(768, 40)).toBeCloseTo(PREVIEW_LONGEST_SIDE / 768);
  });

  it('fits the height to 512 when the content is taller than wide', () => {
    expect(previewScale(300, 1200)).toBeCloseTo(PREVIEW_LONGEST_SIDE / 1200);
  });

  it('keeps content no longer than 512 on any side at its own size', () => {
    expect(previewScale(121, 127)).toBe(1);
    expect(previewScale(512, 40)).toBe(1);
  });
});

describe('buildDragPreview', () => {
  it('sizes the root to the scaled size and scales an inner layer, which carries no class', () => {
    const editor = open([{ type: 'paragraph', content: 'one' }]);
    const contentPlaced = { content: document.createElement('div'), place: null, sizedLike: null };
    const content = contentPlaced.content;
    const root = buildDragPreview(editor.prosemirrorView!, contentPlaced, () => ({ width: 1024, height: 256 }));
    expect(root.isConnected).toBe(true);
    // Its own class: the library's carries `opacity: 0.001`, and Firefox and
    // WebKit draw the root's opacity into the image (inner#1350 design §4).
    expect(root.classList.contains('doc-drag-preview')).toBe(true);
    expect(root.classList.contains('bn-drag-preview')).toBe(false);
    expect(root.style.opacity).toBe('');
    expect(root.style.width).toBe('512px');
    expect(root.style.height).toBe('128px');
    const layer = root.firstElementChild as HTMLElement;
    expect(layer.style.transform).toBe('scale(0.5)');
    expect(layer.style.transformOrigin).toBe('0px 0px');
    expect(layer.style.verticalAlign).toBe('top');
    expect(root.style.transform).toBe('');
    // Its content sits in copies of what it sits in in the body; the layer
    // itself names nothing a rule could reach.
    expect(layer.className).toBe('');
    expect(layer.contains(content)).toBe(true);
  });

  it('is handed to the browser by one exit, anchored at its top left', () => {
    const editor = open([{ type: 'paragraph', content: 'one' }]);
    const setDragImage = vi.fn();

    setDragPreview(editor.prosemirrorView!, { setDragImage } as unknown as DataTransfer, { content: document.createElement('div'), place: null, sizedLike: null });

    expect(setDragImage).toHaveBeenCalledTimes(1);
    const [root, x, y] = setDragImage.mock.calls[0] as [HTMLElement, number, number];
    expect(root.classList.contains('doc-drag-preview')).toBe(true);
    expect([x, y]).toEqual([0, 0]);
  });

  it('leaves the page in the animation frame after it is built, once the browser has taken the image', async () => {
    const editor = open([{ type: 'paragraph', content: 'one' }]);
    const root = buildDragPreview(editor.prosemirrorView!, { content: document.createElement('div'), place: null, sizedLike: null }, () => ({ width: 100, height: 20 }));
    expect(root.isConnected).toBe(true);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(root.isConnected).toBe(false);
  });

  it('stands its first block flush against its top, as the document\'s first block stands, and leaves the space between blocks', () => {
    const editor = open([{ type: 'paragraph', content: 'one' }]);
    const contentPlaced = { content: document.createElement('div'), place: null, sizedLike: null };
    const content = contentPlaced.content;
    content.innerHTML = '<div class="bn-block-content">first</div><div class="bn-block-content">second</div>';
    const root = buildDragPreview(editor.prosemirrorView!, contentPlaced, () => ({ width: 100, height: 40 }));
    const [first, second] = [...root.querySelectorAll<HTMLElement>('.bn-block-content')];
    expect(first!.style.getPropertyValue('--doc-block-lift')).toBe('0px');
    expect(second!.style.getPropertyValue('--doc-block-lift')).toBe('');
  });

  it('puts its content in copies of every element it sits in in the body, from just under the page body', () => {
    const editor = open([{ type: 'paragraph', content: 'one' }]);
    const view = editor.prosemirrorView!;
    const contentPlaced = blockPreviewContent(view, [view.dom.querySelector('.bn-block-outer')!.cloneNode(true) as Element]);
    const content = contentPlaced.content;
    const root = buildDragPreview(view, contentPlaced, () => ({ width: 100, height: 20 }));
    const layer = root.firstElementChild!;
    const shells: Element[] = [];
    for (let at = content.parentElement; at !== null && at !== layer; at = at.parentElement) shells.unshift(at);
    const originals: Element[] = [];
    for (let at: Element | null = view.dom; at !== null && at !== document.body; at = at.parentElement) originals.unshift(at);
    expect(shells.map((shell) => shell.tagName)).toEqual(originals.map((original) => original.tagName));
    expect(shells.at(-1)!.classList.contains('bn-editor')).toBe(true);
    // They lay out and draw nothing of their own (`index.css`), and hold
    // nothing but the way down to the content.
    expect(shells.every((shell) => shell.classList.contains('doc-preview-shell') && shell.childElementCount === 1)).toBe(true);
  });

  it('lets the stylesheet reach its content through those copies, writing no style on it', () => {
    const editor = open([{ type: 'paragraph', content: 'one' }]);
    const view = editor.prosemirrorView!;
    const sheet = document.createElement('style');
    sheet.textContent = '.preview-ancestor .bn-block-content { letter-spacing: 7px; }';
    document.head.append(sheet);
    view.dom.parentElement!.classList.add('preview-ancestor');
    try {
      const contentPlaced = blockPreviewContent(view, [view.dom.querySelector('.bn-block-outer')!.cloneNode(true) as Element]);
      const root = buildDragPreview(view, contentPlaced, () => ({ width: 100, height: 20 }));
      const block = root.querySelector<HTMLElement>('.bn-block-content')!;
      expect(getComputedStyle(block).letterSpacing).toBe('7px');
      expect(block.style.getPropertyValue('letter-spacing')).toBe('');
    } finally {
      sheet.remove();
    }
  });

  it('reads no style element by element, however much the preview holds', () => {
    const editor = open(Array.from({ length: 40 }, (_, at) => ({ type: 'paragraph', content: `line ${at}` })));
    const view = editor.prosemirrorView!;
    const rows = [...view.dom.querySelectorAll(':scope > .bn-block-group > .bn-block-outer')];
    const reads = (count: number): number => {
      const computed = vi.spyOn(window, 'getComputedStyle');
      try {
        buildDragPreview(view, blockPreviewContent(view, rows.slice(0, count).map((row) => row.cloneNode(true) as Element)), () => ({
          width: 100,
          height: 20,
        }));
        return computed.mock.calls.length;
      } finally {
        computed.mockRestore();
      }
    };
    expect(reads(40)).toBe(reads(1));
  });

  it('copies what the content sits in without what it shows for the moment, or what the page would find twice', () => {
    const editor = open([{ type: 'paragraph', content: 'one' }]);
    const view = editor.prosemirrorView!;
    view.dom.classList.add('ProseMirror-focused');
    view.dom.id = 'preview-editor';
    view.dom.setAttribute('data-testid', 'preview-editor');
    view.dom.setAttribute('data-space-outlet', 'space-1');
    const contentPlaced = blockPreviewContent(view, [view.dom.querySelector('.bn-block-outer')!.cloneNode(true) as Element]);
    const content = contentPlaced.content;
    const root = buildDragPreview(view, contentPlaced, () => ({ width: 100, height: 20 }));
    const copy = content.parentElement!;
    expect(copy.classList.contains('bn-editor')).toBe(true);
    expect(copy.classList.contains('ProseMirror-focused')).toBe(false);
    // The editor's rules select by it (`@tiptap/core` `style.ts`).
    expect(copy.getAttribute('contenteditable')).toBe(view.dom.getAttribute('contenteditable'));
    expect(root.querySelector('[id], [data-testid], [data-space-outlet]')).toBeNull();
  });

  it('leaves the page at the first drag event after it is built, when that comes before the next animation frame', () => {
    const editor = open([{ type: 'paragraph', content: 'one' }]);
    const view = editor.prosemirrorView!;
    const after = view.dom.nextSibling;
    const root = buildDragPreview(view, blockPreviewContent(view, [view.dom.querySelector('.bn-block-outer')!.cloneNode(true) as Element]), () => ({
      width: 100,
      height: 20,
    }));
    // Nothing is put beside the editor element; the copy of it inside the
    // preview is on the page until then, where BlockNote looks for an editor
    // under the pointer (`SideMenu.ts:328`) on the drag's events.
    expect(view.dom.nextSibling).toBe(after);
    view.dom.dispatchEvent(new Event('dragover', { bubbles: true }));
    expect(root.isConnected).toBe(false);
    expect(document.querySelectorAll('.bn-editor')).toHaveLength(1);
  });

  it('draws its content as wide as the element in the body it is sized like, whichever builder made it', () => {
    const editor = open([{ type: 'paragraph', content: 'one' }]);
    const sized = document.createElement('div');
    sized.getBoundingClientRect = () => ({ width: 333, height: 20 }) as DOMRect;
    const contentPlaced = { content: document.createElement('div'), place: null, sizedLike: sized };
    const content = contentPlaced.content;
    buildDragPreview(editor.prosemirrorView!, contentPlaced, () => ({ width: 333, height: 20 }));
    expect(content.style.width).toBe('333px');
  });

  it('takes content with where it stands and what it is sized like, never a bare element', () => {
    // @ts-expect-error A preview's content comes with where it stands in the body (`PlacedContent`).
    const unplaced: Parameters<typeof buildDragPreview>[1] = document.createElement('div');
    expect(unplaced).toBeInstanceOf(HTMLElement);
  });

  it('stands its last block flush against its bottom, and leaves the space between blocks', () => {
    const editor = open([{ type: 'paragraph', content: 'one' }]);
    const contentPlaced = { content: document.createElement('div'), place: null, sizedLike: null };
    const content = contentPlaced.content;
    content.innerHTML =
      '<div class="bn-block-content">first</div><div><div class="bn-block-content">nested</div></div><div class="bn-block-content">last</div>';
    const root = buildDragPreview(editor.prosemirrorView!, contentPlaced, () => ({ width: 100, height: 60 }));
    const blocks = [...root.querySelectorAll<HTMLElement>('.bn-block-content')];
    expect(blocks.map((block) => block.style.getPropertyValue('--doc-block-drop'))).toEqual(['', '', '0px']);
  });
});

describe('blockPreviewContent', () => {
  it('takes a text block at the width of the group it sits in, the body column at the top', () => {
    const editor = open([{ type: 'paragraph', content: 'one' }]);
    const view = editor.prosemirrorView!;
    const group = view.dom.querySelector('.bn-block-group')!;
    Object.defineProperty(group, 'getBoundingClientRect', { value: () => ({ width: 720, height: 0, top: 0, left: 0, right: 720, bottom: 0 }) });
    const block = view.dom.querySelector('.bn-block-outer')!.cloneNode(true) as HTMLElement;
    const contentPlaced = blockPreviewContent(view, [block]);
    const content = contentPlaced.content;
    buildDragPreview(view, contentPlaced, () => ({ width: 720, height: 20 }));
    expect(content.style.width).toBe('720px');
    expect(content.textContent).toContain('one');
  });

  it('takes a media block as its media box alone, without the chrome around it', () => {
    const editor = open([{ type: 'paragraph', content: 'x' }]);
    const view = editor.prosemirrorView!;
    const block = blockOf(
      'm1',
      'image',
      '<div data-testid="doc-media-row" class="flex w-full justify-end">' +
        '<div data-media-box="" style="width: 240px"><div data-media-chrome="">bar</div><img alt=""></div></div>',
    );
    const contentPlaced = blockPreviewContent(view, [block]);
    const content = contentPlaced.content;
    expect(content.hasAttribute('data-media-box')).toBe(true);
    expect(content.querySelector('[data-media-chrome]')).toBeNull();
    expect(content.querySelector('img')).not.toBeNull();
  });

  it('takes a media box without the hover and selected state its view writes on it', () => {
    const editor = open([{ type: 'paragraph', content: 'x' }]);
    const view = editor.prosemirrorView!;
    const block = blockOf(
      'm1',
      'image',
      '<div data-testid="doc-media-row" class="flex w-full justify-end">' +
        '<div data-media-box="" data-hovered="true" data-selected="true" style="width: 240px"><img alt=""></div></div>',
    );
    const contentPlaced = blockPreviewContent(view, [block]);
    const content = contentPlaced.content;
    buildDragPreview(view, contentPlaced, () => ({ width: 240, height: 120 }));
    expect(content.hasAttribute('data-media-box')).toBe(true);
    expect(content.hasAttribute('data-hovered')).toBe(false);
    expect(content.hasAttribute('data-selected')).toBe(false);
  });

  it('gives a media box the width it is drawn at in the body, where it may have none of its own', () => {
    const editor = open([{ type: 'paragraph', content: 'x' }]);
    const view = editor.prosemirrorView!;
    // The body's audio box fills its row (`w-full`); the copy is set in a
    // preview that wraps its content, where a full width is no width at all.
    const original = blockOf('audio-1', 'audio', '<div data-media-box="" class="w-full"></div>');
    view.dom.append(original);
    original.querySelector('[data-media-box]')!.getBoundingClientRect = () => ({ width: 768, height: 84 }) as DOMRect;
    const block = blockOf('audio-1', 'audio', '<div data-media-box="" class="w-full"><div data-testid="media-player"></div></div>');
    const contentPlaced = blockPreviewContent(view, [block]);
    const content = contentPlaced.content;
    expect(content.hasAttribute('data-media-box')).toBe(true);
    buildDragPreview(view, contentPlaced, () => ({ width: 768, height: 84 }));
    expect(content.style.width).toBe('768px');
  });

  it('takes a row with a medium nested under it whole: its words, and the medium among its children', () => {
    const editor = open([{ type: 'paragraph', content: 'x' }]);
    const view = editor.prosemirrorView!;
    const block = blockOf(
      'p1',
      'paragraph',
      'parent words',
      blockOf('m1', 'image', '<div data-media-box=""><img alt=""></div>').outerHTML,
    );
    const contentPlaced = blockPreviewContent(view, [block]);
    const content = contentPlaced.content;
    expect(content.matches('[data-media-box]')).toBe(false);
    expect(content.textContent).toContain('parent words');
    expect(content.querySelector('[data-media-box]')).not.toBeNull();
  });

  it('takes a medium with rows nested under it whole, those rows included', () => {
    const editor = open([{ type: 'paragraph', content: 'x' }]);
    const view = editor.prosemirrorView!;
    const block = blockOf(
      'm1',
      'image',
      '<div data-media-box=""><img alt=""></div>',
      blockOf('p1', 'paragraph', 'child words').outerHTML,
    );
    const contentPlaced = blockPreviewContent(view, [block]);
    const content = contentPlaced.content;
    expect(content.matches('[data-media-box]')).toBe(false);
    expect(content.textContent).toContain('child words');
  });

  it('keeps the blocks in a block group, where nested ones take their indent', () => {
    const editor = open([{ type: 'paragraph', content: 'x' }]);
    const view = editor.prosemirrorView!;
    const block = blockOf('p1', 'bulletListItem', 'parent', blockOf('p2', 'bulletListItem', 'child').outerHTML);
    const contentPlaced = blockPreviewContent(view, [block]);
    const content = contentPlaced.content;
    // BlockNote indents a group only inside another group (`Block.css`
    // `.bn-block-group .bn-block-group`).
    const nested = content.querySelector('.bn-block .bn-block-group')!;
    expect(nested.parentElement!.closest('.bn-block-group')).not.toBeNull();
  });

  it('takes a table in the frame it scrolls in, as the body shows it: its edges kept, its scrollbar not', () => {
    const editor = open([{ type: 'paragraph', content: 'x' }]);
    const view = editor.prosemirrorView!;
    const block = document.createElement('div');
    block.className = 'bn-block-outer';
    block.innerHTML =
      '<div class="bn-block-content" data-content-type="table"><div class="doc-table-scroller"><div class="doc-table-frame">' +
      '<div class="relative overflow-hidden"><div data-radix-scroll-area-viewport="" style="overflow: scroll hidden">' +
      '<div style="min-width: 100%; display: table"><div class="tableWrapper"><table><tbody><tr><td>a1</td><td>b1</td></tr></tbody></table></div></div>' +
      '</div><div data-scroll-area-scrollbar=""><div style="width: 511px"></div></div></div>' +
      '<span class="doc-table-overflow-edge" data-overflow-edge="left"></span>' +
      '<span class="doc-table-overflow-edge" data-overflow-edge="right" data-on=""></span>' +
      '</div></div></div>';
    const contentPlaced = blockPreviewContent(view, [block]);
    const content = contentPlaced.content;
    expect(cellTexts(content)).toEqual([['a1', 'b1']]);
    expect(content.querySelector('[data-radix-scroll-area-viewport] table')).not.toBeNull();
    // Shown only while the pointer is over the frame or it scrolls: what the
    // body shows for the moment, like a selection.
    expect(content.querySelector('[data-scroll-area-scrollbar]')).toBeNull();
    // Drawn at rest too, where columns run on past the frame.
    expect(content.querySelectorAll('[data-overflow-edge]')).toHaveLength(2);
  });

  it('leaves out the columns its frame has scrolled wholly out of view on the left, nothing to the left of the preview', () => {
    const editor = open([
      {
        type: 'table',
        content: {
          type: 'tableContent',
          rows: [{ cells: ['a1', 'b1', 'c1'] }, { cells: [{ type: 'tableCell', content: 'ab', props: { colspan: 2 } }, 'c2'] }],
        },
      },
    ]);
    const view = editor.prosemirrorView!;
    scrollFrame(editor, 150);
    // a1 is scrolled off whole; b1 is cut by the frame's left edge and is drawn
    // whole; c1 is in view.
    layOut(editor, { a1: [-30, 90], b1: [90, 230], c1: [230, 380], ab: [-30, 230], c2: [230, 380] });
    const row = view.dom.querySelector('.bn-block-outer')!;
    const root = buildDragPreview(view, blockPreviewContent(view, [row.cloneNode(true) as Element]), () => ({ width: 100, height: 20 }));
    // Taken out, not hidden by a style: WebKit draws a column set to
    // `visibility: collapse`. A cell merged across a column left out loses it.
    expect(cellTexts(root)).toEqual([['b1', 'c1'], ['ab', 'c2']]);
    expect(root.querySelectorAll('col')).toHaveLength(2);
    expect(root.querySelector('tr:last-child td')!.getAttribute('colspan')).toBe('1');
    expect(root.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]')!.scrollLeft).toBe(0);
  });

  it('finds a column scrolled off whose edge only a later row draws, under a cell merged across it in the first', () => {
    const editor = open([
      {
        type: 'table',
        content: {
          type: 'tableContent',
          rows: [{ cells: [{ type: 'tableCell', content: 'ab', props: { colspan: 2 } }, 'c1'] }, { cells: ['a2', 'b2', 'c2'] }],
        },
      },
    ]);
    const view = editor.prosemirrorView!;
    scrollFrame(editor, 150);
    layOut(editor, { ab: [-30, 230], c1: [230, 380], a2: [-30, 90], b2: [90, 230], c2: [230, 380] });
    const row = view.dom.querySelector('.bn-block-outer')!;
    const contentPlaced = blockPreviewContent(view, [row.cloneNode(true) as Element]);
    const content = contentPlaced.content;
    expect(cellTexts(content)).toEqual([['ab', 'c1'], ['b2', 'c2']]);
    expect(content.querySelector('td')!.getAttribute('colspan')).toBe('1');
  });

  it('holds a whole table at the widths and heights the body draws, whatever width the library wrote on it', () => {
    const editor = open([{ type: 'table', content: { type: 'tableContent', rows: [{ cells: ['a1', 'b1', 'c1'] }, { cells: ['a2', 'b2', 'c2'] }] } }]);
    const view = editor.prosemirrorView!;
    layOut(editor, { a1: [0, 100], b1: [100, 220], c1: [220, 360], a2: [0, 100], b2: [100, 220], c2: [220, 360] }, [30, 50]);
    // prosemirror-tables writes the whole table's width on it
    // (`updateColumnsOnResize`), which the copy would carry past the columns
    // it keeps.
    view.dom.querySelector<HTMLElement>('table')!.style.minWidth = '900px';
    const contentPlaced = blockPreviewContent(view, [view.dom.querySelector('.bn-block-outer')!.cloneNode(true) as Element]);
    const content = contentPlaced.content;
    expect(heldTable(content)).toEqual({ cols: ['100px', '120px', '140px'], table: ['360px', '0px', 'fixed'], rows: ['30px', '50px'] });
  });

  it('holds every row at the height the body draws it, one the columns taken out leave empty included', () => {
    const editor = open([
      {
        type: 'table',
        content: {
          type: 'tableContent',
          rows: [{ cells: ['a1', { type: 'tableCell', content: 'merged', props: { rowspan: 2 } }] }, { cells: ['a2'] }],
        },
      },
    ]);
    const view = editor.prosemirrorView!;
    scrollFrame(editor, 150);
    layOut(editor, { a1: [-30, 90], a2: [-30, 90], merged: [90, 230] }, [30, 90]);
    const contentPlaced = blockPreviewContent(view, [view.dom.querySelector('.bn-block-outer')!.cloneNode(true) as Element]);
    const content = contentPlaced.content;
    // The merged cell spans an empty row, at its height, as in the body.
    expect(cellTexts(content)).toEqual([['merged'], []]);
    expect(heldTable(content)).toMatchObject({ cols: ['140px'], rows: ['30px', '90px'] });
  });

  it('draws each video as an empty canvas when it has no original to take a size and a frame from', () => {
    const editor = open([{ type: 'paragraph', content: 'x' }]);
    const view = editor.prosemirrorView!;
    // The body's video player sets no size on the element.
    const block = blockOf('v1', 'video', '<div data-media-box=""><video src="https://example.test/v.mp4" preload="metadata"></video></div>');
    const contentPlaced = blockPreviewContent(view, [block]);
    const content = contentPlaced.content;
    expect(content.querySelector('video')).toBeNull();
    const canvas = content.querySelector('canvas')!;
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
  });

  it('draws a video\'s still at the screen\'s pixels, as the body draws the video', () => {
    const editor = open([{ type: 'paragraph', content: 'x' }]);
    const view = editor.prosemirrorView!;
    const video = '<div data-media-box=""><video src="https://example.test/hd.mp4"></video></div>';
    const original = blockOf('v1', 'video', video);
    view.dom.append(original);
    original.querySelector('video')!.getBoundingClientRect = () => ({ width: 300, height: 150 }) as DOMRect;
    vi.stubGlobal('devicePixelRatio', 2);
    try {
      const canvas = blockPreviewContent(view, [blockOf('v1', 'video', video)]).content.querySelector('canvas')!;
      expect([canvas.width, canvas.height]).toEqual([600, 300]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('draws a video from the copy of the block it sits in, when the same video is in the body twice', () => {
    const editor = open([{ type: 'paragraph', content: 'x' }]);
    const view = editor.prosemirrorView!;
    const video = '<div data-media-box=""><video src="https://example.test/same.mp4"></video></div>';
    const first = blockOf('v1', 'video', video);
    const second = blockOf('v2', 'video', video);
    view.dom.append(first, second);
    first.querySelector('video')!.getBoundingClientRect = () => ({ width: 100, height: 50 }) as DOMRect;
    second.querySelector('video')!.getBoundingClientRect = () => ({ width: 300, height: 150 }) as DOMRect;
    const contentPlaced = blockPreviewContent(view, [blockOf('v2', 'video', video)]);
    const content = contentPlaced.content;
    const canvas = content.querySelector('canvas')!;
    expect([canvas.width, canvas.height]).toEqual([300, 150]);
  });
});

describe('tableLinePreviewContent', () => {
  const rows = [
    { cells: ['a1', 'b1', 'c1'] },
    { cells: ['a2', 'b2', 'c2'] },
    { cells: ['a3', 'b3', 'c3'] },
  ];

  it('keeps the whole dragged row, inside the table block and its colgroup', () => {
    const editor = open([{ type: 'table', content: { type: 'tableContent', columnWidths: [100, 200, 300], rows } }]);
    const contentPlaced = tableLinePreviewContent(editor.prosemirrorView!, cellOf(editor, 'b2'), 'row')!;
    const content = contentPlaced.content;
    const tableBlock = '[data-content-type="table"]';
    expect(content.querySelector(tableBlock) ?? content.matches(tableBlock)).toBeTruthy();
    expect(cellTexts(content)).toEqual([['a2', 'b2', 'c2']]);
    expect([...content.querySelectorAll<HTMLElement>('colgroup col')].map((col) => col.style.width)).toEqual(['100px', '200px', '300px']);
  });

  it('leaves a quoted table\'s rule off a column, which is not the block it stands beside', () => {
    const editor = open([{ type: 'table', content: { type: 'tableContent', rows } }]);
    const view = editor.prosemirrorView!;
    const tableBlock = view.dom.querySelector<HTMLElement>('[data-content-type="table"]')!;
    QUOTE_RUN_ATTRIBUTES.forEach((name) => tableBlock.setAttribute(name, ''));
    const column = tableLinePreviewContent(view, cellOf(editor, 'b2'), 'column')!.content;
    expect(QUOTE_RUN_ATTRIBUTES.filter((name) => column.hasAttribute(name))).toEqual([]);
    const row = tableLinePreviewContent(view, cellOf(editor, 'b2'), 'row')!.content;
    expect(row.hasAttribute('data-quoted-run')).toBe(true);
  });

  it('keeps only the dragged column, and only its col', () => {
    const editor = open([{ type: 'table', content: { type: 'tableContent', columnWidths: [100, 200, 300], rows } }]);
    const contentPlaced = tableLinePreviewContent(editor.prosemirrorView!, cellOf(editor, 'c1'), 'column')!;
    const content = contentPlaced.content;
    expect(cellTexts(content)).toEqual([['c1'], ['c2'], ['c3']]);
    const cols = content.querySelectorAll<HTMLElement>('colgroup col');
    expect(cols.length).toBe(1);
    expect(cols[0]!.style.width).toBe('300px');
  });

  it('draws a line at the column widths and row heights the body draws, the table at their sum', () => {
    const editor = open([{ type: 'table', content: { type: 'tableContent', rows } }]);
    const view = editor.prosemirrorView!;
    // Measured on the cells: WebKit gives a `col` no box (its rect is all 0).
    view.dom.querySelectorAll('col').forEach((col) => {
      col.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect;
    });
    layOut(
      editor,
      { a1: [0, 393], b1: [393, 513], c1: [513, 653], a2: [0, 393], b2: [393, 513], c2: [513, 653], a3: [0, 393], b3: [393, 513], c3: [513, 653] },
      [30, 40, 50],
    );
    // The block's own box carries what its quote's indent adds; the
    // `.bn-block` it sits in does not.
    const tableBlock = view.dom.querySelector<HTMLElement>('[data-content-type="table"]')!;
    tableBlock.getBoundingClientRect = () => ({ width: 744, height: 120 }) as DOMRect;
    tableBlock.parentElement!.getBoundingClientRect = () => ({ width: 720, height: 120 }) as DOMRect;
    const rowPlaced = tableLinePreviewContent(view, cellOf(editor, 'b2'), 'row')!;
    const row = rowPlaced.content;
    const columnPlaced = tableLinePreviewContent(view, cellOf(editor, 'b2'), 'column')!;
    const column = columnPlaced.content;
    // A row keeps every column at the width the whole table gives it: its own
    // cells alone would share the room out another way. The width is the
    // table's, so a quoted block's rule stands outside it. Its block is as wide
    // as the body's, so its frame cuts the table where the body's does.
    expect(heldTable(row)).toEqual({ cols: ['393px', '120px', '140px'], table: ['653px', '0px', 'fixed'], rows: ['40px'] });
    buildDragPreview(view, rowPlaced, () => ({ width: 720, height: 40 }));
    expect(row.style.width).toBe('720px');
    expect(row.querySelector('col')!.style.getPropertyPriority('width')).toBe('important');
    // A column is as wide as itself, the block's own width set to it, and its
    // table stays in the library's wrapper, a block as in the body: in WebKit a
    // collapsed table of a set width laid out as a flex item is 1px wider.
    expect(heldTable(column)).toEqual({ cols: ['120px'], table: ['120px', '0px', 'fixed'], rows: ['30px', '40px', '50px'] });
    buildDragPreview(view, columnPlaced, () => ({ width: 120, height: 120 }));
    expect(column.style.width).toBe('120px');
    const wrapper = column.querySelector<HTMLElement>(':scope > .tableWrapper')!;
    expect(wrapper.querySelector('table')).not.toBeNull();
    // The room it keeps under the table is for the frame's scrollbar.
    expect(wrapper.style.padding).toBe('0px');
  });

  it('keeps a column\'s row a merged cell covers, at its height, under the merged cell', () => {
    const editor = open([
      {
        type: 'table',
        content: {
          type: 'tableContent',
          rows: [{ cells: ['a1', { type: 'tableCell', content: 'merged', props: { rowspan: 2 } }] }, { cells: ['a2'] }],
        },
      },
    ]);
    const view = editor.prosemirrorView!;
    layOut(editor, { a1: [0, 100], a2: [0, 100], merged: [100, 220] }, [30, 90]);
    const columnPlaced = tableLinePreviewContent(view, cellOf(editor, 'merged'), 'column')!;
    const column = columnPlaced.content;
    expect(cellTexts(column)).toEqual([['merged'], []]);
    expect(heldTable(column)).toMatchObject({ rows: ['30px', '90px'] });
  });

  it('holds a table row at the widths of the columns in view, the table at their sum', () => {
    const editor = open([{ type: 'table', content: { type: 'tableContent', rows } }]);
    const view = editor.prosemirrorView!;
    scrollFrame(editor, 150);
    layOut(editor, { a1: [-30, 90], b1: [90, 220], c1: [220, 360], a2: [-30, 90], b2: [90, 220], c2: [220, 360], a3: [-30, 90], b3: [90, 220], c3: [220, 360] });
    const contentPlaced = tableLinePreviewContent(view, cellOf(editor, 'b2'), 'row')!;
    const content = contentPlaced.content;
    expect(cellTexts(content)).toEqual([['b2', 'c2']]);
    expect([...content.querySelectorAll<HTMLElement>('col')].map((col) => col.style.width)).toEqual(['130px', '140px']);
    expect(content.querySelector<HTMLElement>('table')!.style.width).toBe('270px');
  });

  it('lets a line\'s styles reach it inside the block its table sits in', () => {
    const editor = open([{ type: 'table', content: { type: 'tableContent', rows } }]);
    const view = editor.prosemirrorView!;
    const sheet = document.createElement('style');
    sheet.textContent = '.bn-block-outer > .bn-block > [data-content-type="table"] { letter-spacing: 3px; }';
    document.head.append(sheet);
    try {
      const contentPlaced = tableLinePreviewContent(view, cellOf(editor, 'b2'), 'row')!;
      const content = contentPlaced.content;
      buildDragPreview(view, contentPlaced, () => ({ width: 100, height: 20 }));
      expect(getComputedStyle(content).letterSpacing).toBe('3px');
      expect(content.style.getPropertyValue('letter-spacing')).toBe('');
    } finally {
      sheet.remove();
    }
  });

  it('holds a row in the frame its table scrolls in, and a column as its table alone', () => {
    const editor = open([{ type: 'table', content: { type: 'tableContent', rows } }]);
    const view = editor.prosemirrorView!;
    const rowPlaced = tableLinePreviewContent(view, cellOf(editor, 'b2'), 'row')!;
    const row = rowPlaced.content;
    expect(row.querySelector('[data-radix-scroll-area-viewport] table')).not.toBeNull();
    expect(row.querySelector('[data-scroll-area-scrollbar]')).toBeNull();
    expect(row.querySelector('[data-overflow-edge]')).not.toBeNull();
    // A column is narrower than any frame, so it is its table alone, in the
    // library's wrapper.
    const columnPlaced = tableLinePreviewContent(view, cellOf(editor, 'c1'), 'column')!;
    const column = columnPlaced.content;
    expect(column.querySelector(':scope > .tableWrapper table')).not.toBeNull();
    expect(column.querySelector('[data-radix-scroll-area-viewport]')).toBeNull();
    expect(column.querySelector('[data-overflow-edge]')).toBeNull();
  });

  it('finds the column by the table map when a merged cell shifts the cells', () => {
    const editor = open([
      {
        type: 'table',
        content: {
          type: 'tableContent',
          rows: [
            { cells: [{ type: 'tableCell', content: 'ab', props: { colspan: 2 } }, 'c1'] },
            { cells: ['a2', 'b2', 'c2'] },
          ],
        },
      },
    ]);
    const contentPlaced = tableLinePreviewContent(editor.prosemirrorView!, cellOf(editor, 'c2'), 'column')!;
    const content = contentPlaced.content;
    expect(cellTexts(content)).toEqual([['c1'], ['c2']]);
  });
});

describe('tableRowsPreviewContent', () => {
  it('holds the rows of a cell selection at the widths and heights the body draws, its block at the body\'s width', () => {
    const editor = open([
      {
        type: 'table',
        content: { type: 'tableContent', rows: [{ cells: ['a1', 'b1', 'c1'] }, { cells: ['a2', 'b2', 'c2'] }, { cells: ['a3', 'b3', 'c3'] }] },
      },
    ]);
    const view = editor.prosemirrorView!;
    scrollFrame(editor, 150);
    layOut(
      editor,
      { a1: [-30, 90], b1: [90, 220], c1: [220, 360], a2: [-30, 90], b2: [90, 220], c2: [220, 360], a3: [-30, 90], b3: [90, 220], c3: [220, 360] },
      [30, 40, 50],
    );
    view.dom.querySelector<HTMLElement>('table')!.style.minWidth = '900px';
    // The block's own box carries what its quote's indent adds; the
    // `.bn-block` it sits in does not.
    const tableBlock = view.dom.querySelector<HTMLElement>('[data-content-type="table"]')!;
    tableBlock.getBoundingClientRect = () => ({ width: 744, height: 120 }) as DOMRect;
    tableBlock.parentElement!.getBoundingClientRect = () => ({ width: 720, height: 120 }) as DOMRect;
    const contentPlaced = tableRowsPreviewContent(view, cellOf(editor, 'b2'), 1, 3)!;
    const content = contentPlaced.content;
    expect(cellTexts(content)).toEqual([['b2', 'c2'], ['b3', 'c3']]);
    expect(heldTable(content)).toEqual({ cols: ['130px', '140px'], table: ['270px', '0px', 'fixed'], rows: ['40px', '50px'] });
    buildDragPreview(view, contentPlaced, () => ({ width: 720, height: 90 }));
    expect(content.style.width).toBe('720px');
  });
});

describe('a table line or cell selection in its frame', () => {
  /**
   * Opens a table of three columns, its frame scrolled as the body draws it,
   * and its left edge showing that columns lie to the left.
   * @param firstLeft - Where the first column's left edge is; the frame's left is at 100.
   * @returns The editor.
   */
  function scrolledTable(firstLeft: number): Editor {
    const editor = open([
      { type: 'table', content: { type: 'tableContent', rows: [{ cells: ['a1', 'b1', 'c1'] }, { cells: ['a2', 'b2', 'c2'] }] } },
    ]);
    scrollFrame(editor, 20);
    const a = firstLeft + 120;
    layOut(editor, { a1: [firstLeft, a], b1: [a, a + 130], c1: [a + 130, a + 270], a2: [firstLeft, a], b2: [a, a + 130], c2: [a + 130, a + 270] }, [30, 40]);
    editor.prosemirrorView!.dom.querySelector('[data-overflow-edge="left"]')!.setAttribute('data-on', '');
    return editor;
  }

  it('draws the left edge only when columns were taken out on that side', () => {
    const partly = scrolledTable(80);
    const kept = tableLinePreviewContent(partly.prosemirrorView!, cellOf(partly, 'b2'), 'row')!.content;
    expect(cellTexts(kept)).toEqual([['a2', 'b2', 'c2']]);
    expect(kept.querySelector('[data-overflow-edge="left"]')!.hasAttribute('data-on')).toBe(false);
    const rows = tableRowsPreviewContent(partly.prosemirrorView!, cellOf(partly, 'b2'), 0, 2)!.content;
    expect(rows.querySelector('[data-overflow-edge="left"]')!.hasAttribute('data-on')).toBe(false);

    const wholly = scrolledTable(-30);
    const dropped = tableLinePreviewContent(wholly.prosemirrorView!, cellOf(wholly, 'b2'), 'row')!.content;
    expect(cellTexts(dropped)).toEqual([['b2', 'c2']]);
    expect(dropped.querySelector('[data-overflow-edge="left"]')!.hasAttribute('data-on')).toBe(true);
  });

  it('keeps no room under a row or a cell selection for the scrollbar it does not draw, its edges down to the table', () => {
    const editor = scrolledTable(-30);
    const view = editor.prosemirrorView!;
    for (const content of [
      tableLinePreviewContent(view, cellOf(editor, 'b2'), 'row')!.content,
      tableRowsPreviewContent(view, cellOf(editor, 'b2'), 0, 2)!.content,
    ]) {
      expect(content.querySelector<HTMLElement>('.tableWrapper')!.style.padding).toBe('0px');
      content.querySelectorAll<HTMLElement>('[data-overflow-edge]').forEach((edge) => expect(edge.style.bottom).toBe('0px'));
    }
  });
});

describe('measureDrawn', () => {
  /**
   * Gives an element the box it is laid out in.
   * @param element - The element.
   * @param left - Its left edge.
   * @param right - Its right edge.
   * @returns The element.
   */
  function boxed<T extends HTMLElement>(element: T, left: number, right: number): T {
    element.getBoundingClientRect = () => ({ left, right, width: right - left, top: 0, bottom: 20, height: 20 }) as DOMRect;
    return element;
  }

  /**
   * Draws each text node as wide as given, by its text.
   * @param widths - The widths, by text.
   */
  function textWidths(widths: Record<string, number>): void {
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
      const width = widths[this.startContainer.textContent ?? ''] ?? 0;
      return { left: 0, right: width, width, top: 0, bottom: 20, height: 20 } as DOMRect;
    });
  }

  /**
   * A layer laid out from 0 to 768, holding the given elements.
   * @param children - What it holds.
   * @returns The layer, on the page.
   */
  function layerOf(...children: HTMLElement[]): HTMLElement {
    const layer = boxed(document.createElement('div'), 0, 768);
    layer.append(...children);
    document.body.append(layer);
    return layer;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes the width of the words a block holds, not of the block laying them out', () => {
    textWidths({ 'Bullet one': 150 });
    const block = boxed(document.createElement('div'), 0, 768);
    block.textContent = 'Bullet one';
    expect(measureDrawn(layerOf(block)).width).toBe(150);
  });

  it('takes a box that paints, its background or its border, at its full width', () => {
    const panel = boxed(document.createElement('div'), 0, 600);
    panel.style.backgroundColor = 'rgb(1, 2, 3)';
    const ruled = boxed(document.createElement('div'), 0, 640);
    ruled.style.borderBottom = '1px solid rgb(0, 0, 0)';
    expect(measureDrawn(layerOf(panel)).width).toBe(600);
    expect(measureDrawn(layerOf(ruled)).width).toBe(640);
  });

  it('takes a picture, a video or a canvas at its own width', () => {
    expect(measureDrawn(layerOf(boxed(document.createElement('img'), 0, 320))).width).toBe(320);
    expect(measureDrawn(layerOf(boxed(document.createElement('canvas'), 0, 280))).width).toBe(280);
  });

  it('cuts what is drawn to a box that clips it', () => {
    const frame = boxed(document.createElement('div'), 0, 300);
    frame.style.overflowX = 'hidden';
    const table = boxed(document.createElement('div'), 0, 900);
    table.style.border = '1px solid rgb(0, 0, 0)';
    frame.append(table);
    expect(measureDrawn(layerOf(frame)).width).toBe(300);
  });

  it('reads through an element that is no box, which neither clips nor paints nor fades what it holds', () => {
    textWidths({ 'Bullet one': 150 });
    const shell = document.createElement('div');
    shell.style.display = 'contents';
    shell.style.overflowX = 'hidden';
    shell.style.opacity = '0';
    shell.style.backgroundColor = 'rgb(1, 2, 3)';
    const block = boxed(document.createElement('div'), 0, 768);
    block.textContent = 'Bullet one';
    shell.append(block);
    expect(measureDrawn(layerOf(shell)).width).toBe(150);
  });

  it('leaves out what is not shown', () => {
    textWidths({ shown: 100 });
    const edge = boxed(document.createElement('span'), 0, 700);
    edge.style.backgroundColor = 'rgb(1, 2, 3)';
    edge.style.opacity = '0';
    const words = boxed(document.createElement('div'), 0, 768);
    words.textContent = 'shown';
    expect(measureDrawn(layerOf(edge, words)).width).toBe(100);
  });
});
