// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * inner#1314 design §5.2 "两段事务": a move into or out of columns is two
 * transactions, a put-down and a take-away. The size state is asked before
 * the first one goes: a Space that cannot take an add, or is resyncing,
 * refuses the whole move with the add's toast, and nothing is written.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import { TextSelection } from '@tiptap/pm/state';

vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

import { toast } from '@web/lib/toast';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { dropRowBeside } from '@web/spaces/document/document-column-drop';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  getDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { snapshotOf } from '@web/spaces/document/document-version-restore';
import { columnsBlock, para, shapeOf } from '@web/spaces/document/__tests__/column-fixtures';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';
import { enterSize, outcomeOf, type SizeCode } from '@web/data/yjs/__tests__/helpers/size-v2-harness';

const NAME = docName.documentSpace('p1', 'd1');

afterEach(() => {
  clearAllDocSizes();
  _resetDocumentEditorCacheForTests();
  _resetForTests();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

/**
 * Opens the Space's body holding three lines, in a size state.
 * @param code - The size state.
 * @returns The editor handle.
 */
function open(code: SizeCode, blocks: unknown[] = [para('alpha'), para('beta'), para('gamma')]): DocumentEditorHandle {
  const doc = getDoc(NAME);
  const handle = getDocumentEditor(doc, NAME, {
    caretProvider: { awareness: new Awareness(doc) },
    readWho: () => ({ role: 'editor', viewerId: 'u1' }),
    editable: true,
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  adoptDocumentEditor(handle, root);
  handle.editor.replaceBlocks(handle.editor.document, blocks as never);
  handle.undoManager.clear();
  enterSize(NAME, code);
  return handle;
}

/**
 * Drags gamma beside alpha.
 * @param handle - The editor handle.
 */
function dragGammaBesideAlpha(handle: DocumentEditorHandle): void {
  const ids = (handle.editor.document as unknown as { id: string }[]).map((block) => block.id);
  dropRowBeside(handle.editor as never, ids[2]!, ids[0]!, 'right');
}

describe('a move into columns in a Space that cannot take an add', () => {
  it.each(['F', 'O', 'Z'] as const)('[%s] refuses the whole move and writes nothing', async (code) => {
    const handle = open(code);
    dragGammaBesideAlpha(handle);
    // A delete the gate plans is written after the transaction it refused.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shapeOf(handle.editor.document as never)).toEqual(['alpha', 'beta', 'gamma']);
    const want = outcomeOf('add', code);
    const warnings = vi.mocked(toast.warning).mock.calls.map((call) => call[0]);
    expect(warnings).toEqual(want.written || want.toast === null ? [] : [want.toast]);
  });

  it('[W] moves with room left (control)', () => {
    const handle = open('W');
    dragGammaBesideAlpha(handle);
    expect(shapeOf(handle.editor.document as never)).toEqual(['[alpha|gamma]', 'beta']);
  });
});

describe('a delete in a full Space that takes a column\'s last block', () => {
  it.each(['F', 'O'] as const)('[%s] takes the whole column, leaving a valid document', async (code) => {
    const handle = open(code, [para('lead'), columnsBlock(['a'], ['b'])]);
    const group = (handle.editor.document as unknown as { children: { children: { id: string }[] }[] }[])[1]!;
    handle.editor.removeBlocks([group.children[1]!.children[0]!.id] as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { doc } = handle.editor.prosemirrorView.state;
    expect(() => doc.check()).not.toThrow();
    let columns = 0;
    doc.descendants((node) => {
      if (node.type.name === 'docColumn') columns += 1;
      return true;
    });
    expect(shapeOf(handle.editor.document as never)).toEqual(['lead', '[a]']);
    expect(columns).toBeLessThanOrEqual(1);
  });
});

/**
 * The id of the row whose words are these.
 * @param handle - The editor handle.
 * @param words - The words.
 * @returns The id.
 * @throws {Error} When no row holds them.
 */
function rowId(handle: DocumentEditorHandle, words: string): string {
  let id: string | undefined;
  handle.editor.prosemirrorView.state.doc.descendants((node) => {
    if (node.type.name === 'blockContainer' && node.textContent === words) id = String(node.attrs['id']);
    return id === undefined;
  });
  if (id === undefined) throw new Error(`no row "${words}"`);
  return id;
}

describe('deletes in a full Space around columns and cells', () => {
  it.each(['F', 'O'] as const)('[%s] taking every column one after the other leaves no group, and a version still saves', async (code) => {
    const handle = open(code, [para('lead'), columnsBlock(['a'], ['b'])]);
    handle.editor.removeBlocks([rowId(handle, 'a')] as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    handle.editor.removeBlocks([rowId(handle, 'b')] as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { doc } = handle.editor.prosemirrorView.state;
    expect(() => doc.check()).not.toThrow();
    let groups = 0;
    doc.descendants((node) => {
      if (node.type.name === 'docColumnList') groups += 1;
      return true;
    });
    expect(groups).toBe(0);
    expect(() => snapshotOf(doc)).not.toThrow();
  });

  it.each(['F', 'O'] as const)('[%s] taking every block of the body\'s only group at once keeps an empty line in each column', async (code) => {
    const handle = open(code, [columnsBlock(['a'], ['b'])]);
    handle.editor.removeBlocks([rowId(handle, 'a'), rowId(handle, 'b')] as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shapeOf(handle.editor.document as never)).toEqual(['[¶|¶]']);
  });

  it.each(['F', 'O'] as const)('[%s] taking a line and a one-column group\'s last block at once goes through', async (code) => {
    const handle = open(code, [para('lead'), columnsBlock(['a'], ['b'])]);
    handle.editor.removeBlocks([rowId(handle, 'b')] as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    handle.editor.removeBlocks([rowId(handle, 'lead'), rowId(handle, 'a')] as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shapeOf(handle.editor.document as never)).toEqual(['[¶]']);
  });

  it.each([
    ['F', 'alone'],
    ['O', 'alone'],
    ['F', 'with a line after it'],
    ['O', 'with a line after it'],
  ] as const)('[%s] a selection from a whole group (%s) to the end pressed away keeps a line in its first column', async (code, body) => {
    const blocks = body === 'alone' ? [columnsBlock(['a'], ['b'])] : [columnsBlock(['a'], ['b']), para('tail')];
    const handle = open(code, blocks);
    const view = handle.editor.prosemirrorView;
    let from = -1;
    let to = -1;
    view.state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      if (from < 0) from = pos + 1;
      to = pos + 1 + node.content.size;
      return false;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
    view.someProp('handleKeyDown', (handler) => handler(view, event));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(() => view.state.doc.check()).not.toThrow();
    expect(shapeOf(handle.editor.document as never)).toEqual(['[¶]']);
  });

  it.each(['F', 'O'] as const)('[%s] taking the only block of a table cell keeps the cell', async (code) => {
    const handle = open(code, [para('lead'), tableBlock({ rows: [{ cells: ['a', 'b'] }, { cells: ['c', 'd'] }] })]);
    handle.editor.removeBlocks([rowId(handle, 'a')] as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cells: number[] = [];
    handle.editor.prosemirrorView.state.doc.descendants((node) => {
      if (node.type.name === 'docTableRow') cells.push(node.childCount);
      return true;
    });
    expect(cells).toEqual([2, 2]);
  });
});
