// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { documentBodyFragment } from '@breatic/shared/document-body';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { cleanupCodecFixtures, codecFixture } from '@web/spaces/document/__tests__/document-body-codec-fixtures';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

const opened: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  act(() => {
    for (const close of opened.splice(0).reverse()) close();
    cleanupCodecFixtures();
  });
});

/** Mounts the production records binding over two lines. @throws {Error} If setup fails. */
function open(): { editor: ReturnType<typeof buildDocumentEditor>; runtime: ReturnType<typeof createDocumentBodyRuntime> } {
  const doc = codecFixture([{ id: 'lead', text: 'lead' }, { id: 'below', text: 'below words' }]);
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const origin = {};
  const undo = createDocumentUndo(doc, { runtime, origin });
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    body: { document: 'records-transient-blocks', runtime, history: undo.manager, origin },
    extensions: [undo.extension],
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  act(() => { editor.mount(host); });
  opened.push(() => { editor.unmount(); runtime.dispose(); undo.manager.destroy(); host.remove(); });
  return { editor, runtime };
}

/** Reads every paragraph's words in document order. @throws {never} */
function lines(editor: ReturnType<typeof buildDocumentEditor>): string[] {
  const words: string[] = [];
  editor.prosemirrorState.doc.descendants((node) => { if (node.type.name === 'paragraph') words.push(node.textContent); });
  return words;
}

/** Checks the binding published exactly what the editor accepted. @throws {Error} If the binding is absent. */
function expectPublished(editor: ReturnType<typeof buildDocumentEditor>, runtime: ReturnType<typeof createDocumentBodyRuntime>): void {
  expect(runtime.read().status).toBe('active');
  const binding = bodyBindingOf(editor.prosemirrorState);
  if (binding === null) throw new Error('Expected the records binding');
  expect(binding.read().doc.toJSON()).toEqual(editor.prosemirrorState.doc.toJSON());
}

describe('blocks that appear and disappear inside one accepted batch', () => {
  it('leaves no trace of a line inserted and removed by the same transaction', () => {
    const { editor, runtime } = open();
    const view = editor.prosemirrorView!;
    const { schema } = view.state;
    const after = view.state.doc.child(0).child(0).nodeSize + 1;
    act(() => {
      const tr = view.state.tr.insert(after, schema.nodes['blockContainer']!.create(null, schema.nodes['paragraph']!.create()));
      tr.delete(after, after + 4);
      view.dispatch(tr);
    });

    expect(lines(editor)).toEqual(['lead', 'below words']);
    expectPublished(editor, runtime);
  });

  it('takes a whole table and the start of the next line away with one Backspace', () => {
    const { editor, runtime } = open();
    act(() => { editor.insertBlocks([tableBlock({ rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] })] as never, 'lead', 'after'); });
    const view = editor.prosemirrorView!;
    let from = -1;
    let to = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'b1') from = pos + 1;
      if (node.isText && node.text === 'below words') to = pos + 3;
    });
    act(() => { view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to))); });
    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
      view.someProp('handleKeyDown', (handle) => handle(view, event));
    });

    expect(lines(editor)).toEqual(['lead', 'ow words']);
    expect(editor.prosemirrorState.doc.textContent).not.toContain('a1');
    expectPublished(editor, runtime);
  });
});
