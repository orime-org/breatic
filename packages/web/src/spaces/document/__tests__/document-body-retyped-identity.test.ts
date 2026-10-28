// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { documentBodyFragment } from '@breatic/shared/document-body';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import { fillEmptyRow } from '@web/spaces/document/document-insert-row';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { cleanupCodecFixtures, codecFixture } from '@web/spaces/document/__tests__/document-body-codec-fixtures';

const opened: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  act(() => {
    for (const close of opened.splice(0).reverse()) close();
    cleanupCodecFixtures();
  });
});

/** Mounts the production records binding over a line and an empty line. @throws {Error} If setup fails. */
function open(): { editor: ReturnType<typeof buildDocumentEditor>; runtime: ReturnType<typeof createDocumentBodyRuntime>; undo: ReturnType<typeof createDocumentUndo> } {
  const doc = codecFixture([{ id: 'lead', text: 'lead' }, { id: 'row', text: '' }]);
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const origin = {};
  const undo = createDocumentUndo(doc, { runtime, origin });
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    body: { document: 'records-retyped-identity', runtime, history: undo.manager, origin },
    extensions: [undo.extension],
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  act(() => { editor.mount(host); });
  opened.push(() => { editor.unmount(); runtime.dispose(); undo.manager.destroy(); host.remove(); });
  undo.manager.clear();
  undo.manager.stopCapturing();
  return { editor, runtime, undo };
}

/** Lists top-level block types. @throws {never} */
function types(editor: ReturnType<typeof buildDocumentEditor>): string[] {
  return (editor.document as ReadonlyArray<{ type: string }>).map((block) => block.type);
}

describe('a block identity that changes between inline content and structure', () => {
  it('turns an empty line into a table in one undoable write', () => {
    const { editor, runtime } = open();
    act(() => { fillEmptyRow(editor as never, { id: 'row', props: {} } as never, { table: { rows: 2, cols: 2 } }); });

    expect(runtime.read().status).toBe('active');
    expect(types(editor)).toEqual(['paragraph', 'docTable']);
    let first: { from: number; to: number } | undefined;
    editor.prosemirrorState.doc.descendants((node, pos) => {
      if (first === undefined && node.type.spec.tableRole === 'cell') first = { from: pos, to: pos + node.nodeSize };
    });
    const caret = editor.prosemirrorState.selection.from;
    expect(first !== undefined && caret > first.from && caret < first.to).toBe(true);
    const binding = bodyBindingOf(editor.prosemirrorState);
    expect(binding?.read().doc.toJSON()).toEqual(editor.prosemirrorState.doc.toJSON());

    act(() => { editor.undo(); });
    expect(runtime.read().status).toBe('active');
    expect(types(editor)).toEqual(['paragraph', 'paragraph']);
  });
});
