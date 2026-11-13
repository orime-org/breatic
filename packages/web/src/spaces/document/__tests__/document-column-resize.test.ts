// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1314 A3 and design §5.4: dragging the divider between two columns
 * changes their widths, the two only, never under 96px, and one write on
 * release that one undo takes back.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { resizedWeights, writeColumnWidths } from '@web/spaces/document/document-column-resize';
import { adoptDocumentEditor, getDocumentEditor } from '@web/spaces/document/document-editor-cache';
import { columnsBlock, para } from '@web/spaces/document/__tests__/column-fixtures';

afterEach(() => {
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
