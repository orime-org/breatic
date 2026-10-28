// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import type { EditorView } from '@tiptap/pm/view';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { documentBodyFragment } from '@breatic/shared/document-body';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
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

/** Mounts the production records binding over one empty line. @throws {Error} If setup fails. */
function open(): { editor: ReturnType<typeof buildDocumentEditor>; view: EditorView; runtime: ReturnType<typeof createDocumentBodyRuntime> } {
  const doc = codecFixture([{ id: 'line', text: '' }]);
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const origin = {};
  const undo = createDocumentUndo(doc, { runtime, origin });
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    body: { document: 'records-speculative-apply', runtime, history: undo.manager, origin },
    extensions: [undo.extension],
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  act(() => { editor.mount(host); });
  opened.push(() => { editor.unmount(); runtime.dispose(); undo.manager.destroy(); host.remove(); });
  const view = editor.prosemirrorView;
  if (view === undefined) throw new Error('Expected a mounted view');
  let end = -1;
  view.state.doc.descendants((node, pos) => { if (end < 0 && node.type.name === 'paragraph') end = pos + 1 + node.content.size; });
  act(() => { view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end))); });
  return { editor, view, runtime };
}

describe('records binding under speculative state application', () => {
  it('stays writable after a transaction is applied to a state that is never dispatched', () => {
    const { editor, view, runtime } = open();
    const binding = bodyBindingOf(view.state);
    view.state.apply(view.state.tr.insertText('x'));
    expect(binding?.phase()).toBe('idle');
    expect(binding?.canWrite()).toBe(true);

    act(() => { view.dispatch(view.state.tr.insertText('kept')); });

    expect(runtime.read().status).toBe('active');
    expect((editor.document[0] as { content?: unknown } | undefined)?.content).toEqual([{ type: 'text', text: 'kept', styles: {} }]);
  });
});
