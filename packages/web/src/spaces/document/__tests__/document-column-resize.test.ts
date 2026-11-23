// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * inner#1314 A3 and design §5.4: dragging the divider between two columns
 * changes their widths, the two only, never under 96px, and one write on
 * release that one undo takes back.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { COLUMN_GAP, weightsFit } from '@web/spaces/document/document-column-geometry';
import { resizedWeights, writeColumnWidths } from '@web/spaces/document/document-column-resize';
import { adoptDocumentEditor, getDocumentEditor } from '@web/spaces/document/document-editor-cache';
import { columnsBlock, para } from '@web/spaces/document/__tests__/column-fixtures';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { enterSize } from '@web/data/yjs/__tests__/helpers/size-v2-harness';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';

vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

afterEach(() => {
  clearAllDocSizes();
  _resetDocumentEditorCacheForTests();
  _resetForTests();
  document.body.innerHTML = '';
});

describe('the widths a divider drag gives (design §5.4)', () => {
  it('moves the width between the two columns, keeping their total weight', () => {
    expect(resizedWeights({ leftPx: 300, rightPx: 300, leftWeight: 1, rightWeight: 1, dx: 60 })).toEqual({ left: 1.2, right: 0.8 });
  });

  it('stops each column at 96px', () => {
    expect(resizedWeights({ leftPx: 300, rightPx: 300, leftWeight: 1, rightWeight: 1, dx: 400 })).toEqual({ left: 1.68, right: 0.32 });
    expect(resizedWeights({ leftPx: 300, rightPx: 300, leftWeight: 1, rightWeight: 1, dx: -400 })).toEqual({ left: 0.32, right: 1.68 });
  });

  it('keeps a column dragged to 96px side by side, whatever the room', () => {
    const stacked: number[] = [];
    for (let width = 300; width <= 1200; width += 1) {
      const half = (width - COLUMN_GAP) / 2;
      for (const dx of [-10_000, 10_000]) {
        const { left, right } = resizedWeights({ leftPx: half, rightPx: half, leftWeight: 1, rightWeight: 1, dx });
        if (!weightsFit(width, [left, right])) stacked.push(width);
      }
    }
    expect(stacked).toEqual([]);
  });

  it('keeps a column dragged to 96px side by side when the pair\'s weights are off four places', () => {
    // A swap gives the new column the mean weight, 0.98785.
    const weights = [0.9757, 1, 0.98785];
    const sum = weights.reduce((total, weight) => total + weight, 0);
    const stacked: number[] = [];
    for (let width = 600; width <= 900; width += 0.25) {
      const px = weights.map((weight) => ((width - 2 * COLUMN_GAP) * weight) / sum);
      const { left, right } = resizedWeights({ leftPx: px[1]!, rightPx: px[2]!, leftWeight: 1, rightWeight: 0.98785, dx: 10_000 });
      if (!weightsFit(width, [weights[0]!, left, right])) stacked.push(width);
    }
    expect(stacked).toEqual([]);
  });

  it('leaves a pair already at the minimum where it is', () => {
    expect(resizedWeights({ leftPx: 96, rightPx: 96, leftWeight: 1, rightWeight: 1, dx: 50 })).toEqual({ left: 1, right: 1 });
  });
});

describe('writing the widths on release', () => {
  it('writes both columns in one step that one undo takes back', () => {
    const doc = new Y.Doc();
    const handle = getDocumentEditor(doc, `project-p/document-${String(Math.random())}`, {
      caretProvider: { awareness: new Awareness(doc) },
      readWho: () => ({ role: 'editor', viewerId: 'user-1' }),
      editable: true,
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    adoptDocumentEditor(handle, root);
    const { editor } = handle;
    editor.replaceBlocks(editor.document, [para('lead'), columnsBlock(['a'], ['b'], ['c'])] as never);
    handle.undoManager.clear();
    const group = editor.document[1] as unknown as { children: { id: string; props: { width: number } }[] };
    const [first, second] = group.children;
    writeColumnWidths(editor.prosemirrorView, [
      { id: first!.id, width: 1.2 },
      { id: second!.id, width: 0.8 },
    ]);
    const widths = (): number[] =>
      (editor.document[1] as unknown as { children: { props: { width: number } }[] }).children.map((column) => column.props.width);
    expect(widths()).toEqual([1.2, 0.8, 1]);
    handle.undoManager.undo();
    expect(widths()).toEqual([1, 1, 1]);
  });
});

describe('a divider drag the Space refuses to write', () => {
  it.each(['F', 'Z'] as const)('[%s] puts the columns back to the widths the document keeps', (code) => {
    const name = docName.documentSpace('p1', 'd1');
    const doc = getDoc(name);
    const handle = getDocumentEditor(doc, name, {
      caretProvider: { awareness: new Awareness(doc) },
      readWho: () => ({ role: 'editor', viewerId: 'user-1' }),
      editable: true,
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    adoptDocumentEditor(handle, root);
    handle.editor.replaceBlocks(handle.editor.document, [para('lead'), columnsBlock(['a'], ['b'])] as never);
    enterSize(name, code);
    const group = root.querySelector('.doc-columns') as HTMLElement;
    const columns = [...group.querySelectorAll<HTMLElement>(':scope > .doc-columns-row > .doc-column')];
    for (const [index, column] of columns.entries()) {
      column.getBoundingClientRect = () => ({ left: index * 372, right: index * 372 + 300, width: 300, top: 0, bottom: 20, height: 20, x: index * 372, y: 0, toJSON: () => ({}) });
    }
    const divider = group.querySelector('.doc-column-divider') as HTMLElement;
    divider.dataset['index'] = '1';
    divider.dispatchEvent(new MouseEvent('pointerdown', { clientX: 336, bubbles: true, cancelable: true }));
    divider.dispatchEvent(new MouseEvent('pointermove', { clientX: 396, bubbles: true }));
    expect(columns[0]!.style.flexGrow).not.toBe('1');

    divider.dispatchEvent(new MouseEvent('pointerup', { clientX: 396, bubbles: true }));

    expect(columns.map((column) => column.style.flexGrow)).toEqual(['1', '1']);
  });
});

describe('where the divider can be taken (WCAG 2.2 SC 2.5.8)', () => {
  /**
   * Two columns 300px wide, 72px apart, in a mounted editor.
   * @returns The group and its divider.
   */
  function twoColumns(): { group: HTMLElement; divider: HTMLElement } {
    const name = docName.documentSpace('p1', 'd2');
    const doc = getDoc(name);
    const handle = getDocumentEditor(doc, name, {
      caretProvider: { awareness: new Awareness(doc) },
      readWho: () => ({ role: 'editor', viewerId: 'user-1' }),
      editable: true,
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    adoptDocumentEditor(handle, root);
    handle.editor.replaceBlocks(handle.editor.document, [para('lead'), columnsBlock(['a'], ['b'])] as never);
    const group = root.querySelector('.doc-columns') as HTMLElement;
    for (const [index, column] of group.querySelectorAll<HTMLElement>(':scope > .doc-columns-row > .doc-column').entries()) {
      column.getBoundingClientRect = () => ({ left: index * 372, right: index * 372 + 300, width: 300, top: 0, bottom: 20, height: 20, x: index * 372, y: 0, toJSON: () => ({}) });
    }
    return { group, divider: group.querySelector('.doc-column-divider') as HTMLElement };
  }

  it.each([-12, -6, 0, 6, 12])('shows the divider %ipx off the gap\'s middle', (offset) => {
    const { group, divider } = twoColumns();
    group.dispatchEvent(new MouseEvent('pointermove', { clientX: 336 + offset, bubbles: true }));
    expect(divider.dataset['shown']).toBe('');
  });

  it.each([-13, 13])('leaves the gap %ipx off its middle to the blocks beside it', (offset) => {
    const { group, divider } = twoColumns();
    group.dispatchEvent(new MouseEvent('pointermove', { clientX: 336 + offset, bubbles: true }));
    expect(divider.dataset['shown']).toBeUndefined();
  });
});
