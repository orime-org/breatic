// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Loaded layout tables keep their content DOM while React mounts their chrome. */

import * as React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  getDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

interface LoadedTable {
  readonly handle: DocumentEditorHandle;
  readonly doc: Y.Doc;
  readonly tree: unknown;
  readonly bytes: Uint8Array;
}

interface MountedContent {
  readonly table: HTMLTableElement | null;
  readonly body: HTMLTableSectionElement | null;
  readonly connected: boolean;
}

const documents: Y.Doc[] = [];
const cursors: Awareness[] = [];
const seedEditors: ReturnType<typeof buildDocumentEditor>[] = [];

/**
 * Creates a stored table through the real block API, then opens its Yjs copy.
 * @returns A fresh cache handle whose table content has already arrived.
 */
function loadedTable(): LoadedTable {
  const seed = new Y.Doc();
  const doc = new Y.Doc();
  documents.push(seed, doc);
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(seed) });
  seedEditors.push(editor);
  act(() => {
    const host = document.createElement('div');
    document.body.append(host);
    editor.mount(host);
    editor.replaceBlocks(editor.document, [
      tableBlock({
        headerRows: 1,
        columnWidths: [180, 220],
        rows: [
          { cells: ['H1', 'H2'] },
          { cells: [{ blocks: [{
            type: 'paragraph',
            content: [{ type: 'text', text: 'ALPHA', styles: { bold: true } }],
          }] }, 'BETA'] },
        ],
      }),
      { type: 'paragraph', content: 'TAIL' },
    ] as never);
  });
  const tree: unknown = editor.prosemirrorState.doc.toJSON();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
  const cursor = new Awareness(doc);
  cursors.push(cursor);
  const handle = getDocumentEditor(doc, 'project-p/document-loaded-table', {
    caretProvider: { awareness: cursor },
    readWho: () => ({ role: 'editor', viewerId: 'reader-1' }),
    editable: true,
  });
  return { handle, doc, tree, bytes: Y.encodeStateAsUpdate(doc) };
}

/**
 * Mounts from the same React effect boundary as DocumentEditor.
 * @param props - The cached editor and observations made synchronously.
 * @param props.handle - The loaded document cache handle.
 * @param props.snapshots - Receives the content DOM before the effect returns.
 * @returns The container adopting the editor surface.
 */
function EffectMountedBody({ handle, snapshots }: {
  handle: DocumentEditorHandle;
  snapshots: MountedContent[];
}): React.JSX.Element {
  const container = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    adoptDocumentEditor(handle, container.current!);
    const table = handle.surface.querySelector<HTMLTableElement>('table');
    const body = table?.tBodies[0] ?? null;
    snapshots.push({ table, body, connected: table?.isConnected === true && body?.isConnected === true });
  }, [handle, snapshots]);
  return <div ref={container} />;
}

afterEach(async () => {
  await act(async () => {
    cleanup();
    _resetDocumentEditorCacheForTests();
    for (const editor of seedEditors.splice(0)) editor.unmount();
    await Promise.resolve();
  });
  for (const cursor of cursors.splice(0)) cursor.destroy();
  for (const doc of documents.splice(0)) doc.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe.each([false, true])('loaded table mounted from a React effect, StrictMode=%s', (strict) => {
  it('has synchronous stable content DOM, reports no console errors and preserves content through edit and undo', async () => {
    const loaded = loadedTable();
    const errors = vi.spyOn(console, 'error');
    const snapshots: MountedContent[] = [];
    const content = <EffectMountedBody handle={loaded.handle} snapshots={snapshots} />;
    const { container } = render(strict ? <React.StrictMode>{content}</React.StrictMode> : content);

    await waitFor(() => {
      expect(container.querySelectorAll('.doc-table-frame')).toHaveLength(1);
      expect(container.querySelectorAll('table')).toHaveLength(1);
      expect(container.querySelectorAll('tbody')).toHaveLength(1);
    });
    expect(errors.mock.calls).toEqual([]);
    const table = container.querySelector('table')!;
    const body = table.tBodies[0]!;
    expect(snapshots[0]?.table).toBe(table);
    for (const snapshot of snapshots) {
      expect(snapshot.table).toBe(table);
      expect(snapshot.body).toBe(body);
      expect(snapshot.connected).toBe(true);
    }
    expect(table.closest('[data-radix-scroll-area-viewport]')?.closest('.doc-table-frame')).toBe(container.querySelector('.doc-table-frame'));
    expect(loaded.handle.editor.prosemirrorState.doc.toJSON()).toEqual(loaded.tree);
    expect(loaded.handle.editor.prosemirrorState.doc.textContent).toBe('H1H2ALPHABETATAIL');
    expect(Y.encodeStateAsUpdate(loaded.doc)).toEqual(loaded.bytes);

    const { editor, undoManager } = loaded.handle;
    let afterAlpha = -1;
    editor.prosemirrorState.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'ALPHA') afterAlpha = pos + node.nodeSize;
      return true;
    });
    expect(afterAlpha).toBeGreaterThan(0);
    undoManager.clear();
    act(() => {
      undoManager.stopCapturing();
      editor.prosemirrorView.dispatch(editor.prosemirrorState.tr.insertText('!', afterAlpha));
      undoManager.stopCapturing();
    });
    expect(editor.prosemirrorState.doc.textContent).toBe('H1H2ALPHA!BETATAIL');
    expect(undoManager.undoStack).toHaveLength(1);
    expect(container.querySelector('table')).toBe(table);
    expect(table.tBodies[0]).toBe(body);
    act(() => { undoManager.undo(); });
    expect(editor.prosemirrorState.doc.toJSON()).toEqual(loaded.tree);
    expect(container.querySelector('table')).toBe(table);
    expect(table.tBodies[0]).toBe(body);
    expect(errors.mock.calls).toEqual([]);
  });
});
