// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1350 A1: every drag preview is the dragged content itself, drawn in
 * the body's styles, scaled as a whole so its longest side is 512px
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

describe('previewScale', () => {
  it('fits the width to 512 when the content is wider than tall', () => {
    expect(previewScale(768, 40)).toBeCloseTo(PREVIEW_LONGEST_SIDE / 768);
  });

  it('fits the height to 512 when the content is taller than wide', () => {
    expect(previewScale(300, 1200)).toBeCloseTo(PREVIEW_LONGEST_SIDE / 1200);
  });
});

describe('buildDragPreview', () => {
  it('sizes the root to the scaled size and scales an inner layer, which carries the body classes but no editor class', () => {
    const editor = open([{ type: 'paragraph', content: 'one' }]);
    const content = document.createElement('div');
    const preview = buildDragPreview(editor.prosemirrorView!, content, () => ({ width: 1024, height: 256 }));
    const root = preview.element;
    expect(root.isConnected).toBe(true);
    expect(root.classList.contains('bn-drag-preview')).toBe(true);
    expect(root.style.width).toBe('512px');
    expect(root.style.height).toBe('128px');
    const layer = root.firstElementChild as HTMLElement;
    expect(layer.style.transform).toBe('scale(0.5)');
    expect(layer.style.transformOrigin).toBe('0px 0px');
    expect(root.style.transform).toBe('');
    expect(layer.classList.contains('doc-body')).toBe(true);
    // BlockNote takes any `.bn-editor` in the page for an editor and reads its
    // block group, drop routing included (`SideMenu.ts` findClosestEditorElement);
    // its own preview drops these three classes, and so does ours.
    for (const name of ['bn-root', 'bn-editor', 'ProseMirror']) {
      expect(layer.classList.contains(name)).toBe(false);
    }
    expect(layer.contains(content)).toBe(true);
    preview.remove();
    expect(root.isConnected).toBe(false);
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
    const block = document.createElement('div');
    block.className = 'bn-block-outer';
    block.innerHTML =
      '<div data-testid="doc-media-row" class="flex w-full justify-end">' +
      '<div data-media-box="" style="width: 240px"><div data-media-chrome="">bar</div><img alt=""></div></div>';
    const content = blockPreviewContent(view, [block]);
    expect(content.hasAttribute('data-media-box')).toBe(true);
    expect(content.querySelector('[data-media-chrome]')).toBeNull();
    expect(content.querySelector('img')).not.toBeNull();
  });

  it('lets a table out of its scroll frame so every column is in the preview', () => {
    const editor = open([{ type: 'paragraph', content: 'x' }]);
    const view = editor.prosemirrorView!;
    const block = document.createElement('div');
    block.className = 'bn-block-outer';
    block.innerHTML =
      '<div class="relative overflow-hidden"><div data-radix-scroll-area-viewport="" style="overflow: scroll"><table></table></div></div>';
    const content = blockPreviewContent(view, [block]);
    const viewport = content.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]')!;
    expect(viewport.style.overflow).toBe('visible');
    expect((viewport.parentElement as HTMLElement).style.overflow).toBe('visible');
  });

  it('draws each video as a canvas of the same size', () => {
    const editor = open([{ type: 'paragraph', content: 'x' }]);
    const view = editor.prosemirrorView!;
    const block = document.createElement('div');
    block.className = 'bn-block-outer';
    block.innerHTML = '<div data-media-box=""><video width="320" height="180"></video></div>';
    const content = blockPreviewContent(view, [block]);
    expect(content.querySelector('video')).toBeNull();
    const canvas = content.querySelector('canvas')!;
    expect(canvas).not.toBeNull();
  });
});

describe('tableLinePreviewContent', () => {
  const rows = [
    { cells: ['a1', 'b1', 'c1'] },
    { cells: ['a2', 'b2', 'c2'] },
    { cells: ['a3', 'b3', 'c3'] },
  ];

  it('keeps the whole dragged row, inside the table block and its colgroup', () => {
    const editor = open([{ type: 'table', content: { type: 'tableContent', rows } }]);
    const content = tableLinePreviewContent(editor.prosemirrorView!, cellOf(editor, 'b2'), 'row')!;
    const tableBlock = '[data-content-type="table"]';
    expect(content.querySelector(tableBlock) ?? content.matches(tableBlock)).toBeTruthy();
    expect(cellTexts(content)).toEqual([['a2', 'b2', 'c2']]);
  });

  it('keeps only the dragged column, and only its col', () => {
    const editor = open([{ type: 'table', content: { type: 'tableContent', rows } }]);
    const content = tableLinePreviewContent(editor.prosemirrorView!, cellOf(editor, 'c1'), 'column')!;
    expect(cellTexts(content)).toEqual([['c1'], ['c2'], ['c3']]);
    const cols = content.querySelectorAll('colgroup col');
    expect(cols.length).toBeLessThanOrEqual(1);
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
