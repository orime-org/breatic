// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1350 A1: every drag preview is the dragged content itself, drawn in
 * the body's styles, scaled down as a whole so its longest side is at most
 * 512px
 * (design §4).
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  PREVIEW_LONGEST_SIDE,
  blockPreviewContent,
  buildDragPreview,
  previewScale,
  tableLinePreviewContent,
} from '@web/spaces/document/document-drag-preview';

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
  const host = document.createElement('div');
  document.body.appendChild(host);
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
  it('sizes the root to the scaled size and scales an inner layer, which carries the body classes but no editor class', () => {
    const editor = open([{ type: 'paragraph', content: 'one' }]);
    const content = document.createElement('div');
    const preview = buildDragPreview(editor.prosemirrorView!, content, () => ({ width: 1024, height: 256 }));
    const root = preview.element;
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
    expect(layer.classList.contains('doc-body')).toBe(true);
    // BlockNote takes any `.bn-editor` in the page for an editor and reads its
    // block group, drop routing included (`SideMenu.ts` findClosestEditorElement);
    // its own preview drops these three classes, and so does ours.
    for (const name of ['bn-root', 'bn-editor', 'ProseMirror']) {
      expect(layer.classList.contains(name)).toBe(false);
    }
    expect(layer.contains(content)).toBe(true);
  });

  it('leaves the page in the animation frame after it is built, once the browser has taken the image', async () => {
    const editor = open([{ type: 'paragraph', content: 'one' }]);
    const preview = buildDragPreview(editor.prosemirrorView!, document.createElement('div'), () => ({ width: 100, height: 20 }));
    expect(preview.element.isConnected).toBe(true);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(preview.element.isConnected).toBe(false);
  });

  it('stands its first block flush against its top, as the document\'s first block stands, and leaves the space between blocks', () => {
    const editor = open([{ type: 'paragraph', content: 'one' }]);
    const content = document.createElement('div');
    content.innerHTML = '<div class="bn-block-content">first</div><div class="bn-block-content">second</div>';
    const preview = buildDragPreview(editor.prosemirrorView!, content, () => ({ width: 100, height: 40 }));
    const [first, second] = [...preview.element.querySelectorAll<HTMLElement>('.bn-block-content')];
    expect(first!.style.getPropertyValue('--doc-block-lift')).toBe('0px');
    expect(second!.style.getPropertyValue('--doc-block-lift')).toBe('');
  });
});

describe('blockPreviewContent', () => {
  it('takes a text block at the width of the body column', () => {
    const editor = open([{ type: 'paragraph', content: 'one' }]);
    const view = editor.prosemirrorView!;
    Object.defineProperty(view.dom, 'clientWidth', { value: 720, configurable: true });
    const block = view.dom.querySelector('.bn-block-outer')!.cloneNode(true) as HTMLElement;
    const content = blockPreviewContent(view, [block]);
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
    const content = blockPreviewContent(view, [block]);
    expect(content.hasAttribute('data-media-box')).toBe(true);
    expect(content.querySelector('[data-media-chrome]')).toBeNull();
    expect(content.querySelector('img')).not.toBeNull();
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
    const content = blockPreviewContent(view, [block]);
    expect(content.hasAttribute('data-media-box')).toBe(true);
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
    const content = blockPreviewContent(view, [block]);
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
    const content = blockPreviewContent(view, [block]);
    expect(content.matches('[data-media-box]')).toBe(false);
    expect(content.textContent).toContain('child words');
  });

  it('keeps the blocks in a block group, where nested ones take their indent', () => {
    const editor = open([{ type: 'paragraph', content: 'x' }]);
    const view = editor.prosemirrorView!;
    const block = blockOf('p1', 'bulletListItem', 'parent', blockOf('p2', 'bulletListItem', 'child').outerHTML);
    const content = blockPreviewContent(view, [block]);
    // BlockNote indents a group only inside another group (`Block.css`
    // `.bn-block-group .bn-block-group`).
    const nested = content.querySelector('.bn-block .bn-block-group')!;
    expect(nested.parentElement!.closest('.bn-block-group')).not.toBeNull();
  });

  it('takes a table out of its scroll frame: every column, and none of the frame\'s scrollbar or edges', () => {
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
    const content = blockPreviewContent(view, [block]);
    expect(content.querySelector('[data-content-type="table"] > table')).not.toBeNull();
    expect(cellTexts(content)).toEqual([['a1', 'b1']]);
    expect(content.querySelector('[data-radix-scroll-area-viewport]')).toBeNull();
    expect(content.querySelector('[data-scroll-area-scrollbar]')).toBeNull();
    expect(content.querySelector('[data-overflow-edge]')).toBeNull();
  });

  it('draws each video as an empty canvas when it has no original to take a size and a frame from', () => {
    const editor = open([{ type: 'paragraph', content: 'x' }]);
    const view = editor.prosemirrorView!;
    // The body's video player sets no size on the element.
    const block = blockOf('v1', 'video', '<div data-media-box=""><video src="https://example.test/v.mp4" preload="metadata"></video></div>');
    const content = blockPreviewContent(view, [block]);
    expect(content.querySelector('video')).toBeNull();
    const canvas = content.querySelector('canvas')!;
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
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
    const content = blockPreviewContent(view, [blockOf('v2', 'video', video)]);
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
    const content = tableLinePreviewContent(editor.prosemirrorView!, cellOf(editor, 'b2'), 'row')!;
    const tableBlock = '[data-content-type="table"]';
    expect(content.querySelector(tableBlock) ?? content.matches(tableBlock)).toBeTruthy();
    expect(cellTexts(content)).toEqual([['a2', 'b2', 'c2']]);
    expect([...content.querySelectorAll<HTMLElement>('colgroup col')].map((col) => col.style.width)).toEqual(['100px', '200px', '300px']);
  });

  it('keeps only the dragged column, and only its col', () => {
    const editor = open([{ type: 'table', content: { type: 'tableContent', columnWidths: [100, 200, 300], rows } }]);
    const content = tableLinePreviewContent(editor.prosemirrorView!, cellOf(editor, 'c1'), 'column')!;
    expect(cellTexts(content)).toEqual([['c1'], ['c2'], ['c3']]);
    const cols = content.querySelectorAll<HTMLElement>('colgroup col');
    expect(cols.length).toBe(1);
    expect(cols[0]!.style.width).toBe('300px');
  });

  it('sets a row at its table\'s width and a column at its cell\'s, the widths they are drawn at in the body', () => {
    const editor = open([{ type: 'table', content: { type: 'tableContent', rows } }]);
    const view = editor.prosemirrorView!;
    view.dom.querySelector('table')!.getBoundingClientRect = () => ({ width: 1081, height: 90 }) as DOMRect;
    (view.nodeDOM(cellOf(editor, 'c1')) as HTMLElement).getBoundingClientRect = () => ({ width: 121, height: 30 }) as DOMRect;
    expect(tableLinePreviewContent(view, cellOf(editor, 'b2'), 'row')!.style.width).toBe('1081px');
    expect(tableLinePreviewContent(view, cellOf(editor, 'c2'), 'column')!.style.width).toBe('121px');
  });

  it('holds the line\'s table and nothing of the frame the table scrolls in', () => {
    const editor = open([{ type: 'table', content: { type: 'tableContent', rows } }]);
    const view = editor.prosemirrorView!;
    // The frame the body draws around a table (`document-table-blocknote.tsx`)
    // is a React view a test page does not mount; its parts are put in place.
    const table = view.dom.querySelector('table')!;
    const viewport = document.createElement('div');
    viewport.setAttribute('data-radix-scroll-area-viewport', '');
    table.replaceWith(viewport);
    viewport.append(table);
    const scrollbar = document.createElement('div');
    scrollbar.setAttribute('data-scroll-area-scrollbar', '');
    const edge = document.createElement('span');
    edge.setAttribute('data-overflow-edge', 'right');
    viewport.after(scrollbar, edge);
    const content = tableLinePreviewContent(view, cellOf(editor, 'c1'), 'column')!;
    expect(content.querySelector(':scope > table')).not.toBeNull();
    expect(content.querySelector('[data-radix-scroll-area-viewport]')).toBeNull();
    expect(content.querySelector('[data-scroll-area-scrollbar]')).toBeNull();
    expect(content.querySelector('[data-overflow-edge]')).toBeNull();
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
    const content = tableLinePreviewContent(editor.prosemirrorView!, cellOf(editor, 'c2'), 'column')!;
    expect(cellTexts(content)).toEqual([['c1'], ['c2']]);
  });
});
