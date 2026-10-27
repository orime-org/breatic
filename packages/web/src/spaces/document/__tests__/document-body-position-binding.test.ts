// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared/document-body';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import type { BodyProjection } from '@web/spaces/document/document-body-codec-types';
import { nameBodyPoint, resolveBodyPoint } from '@web/spaces/document/document-body-positions';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';

const opened: ReturnType<typeof open>[] = [];

/** Opens the current document seed through the production factory and history. @throws {Error} If assembly fails. */
function open(source?: Y.Doc): {
  doc: Y.Doc;
  editor: ReturnType<typeof buildDocumentEditor>;
  runtime: ReturnType<typeof createDocumentBodyRuntime>;
  undo: ReturnType<typeof createDocumentUndo>;
  host: HTMLElement;
} {
  const doc = source ?? new Y.Doc({ gc: false });
  if (source === undefined) Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const origin = {};
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const undo = createDocumentUndo(doc, { runtime, origin });
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc),
    body: { document: 'document:position-binding', origin, runtime, history: undo.manager }, extensions: [undo.extension] });
  const host = document.createElement('div');
  document.body.append(host);
  act(() => editor.mount(host));
  const body = { doc, editor, runtime, undo, host };
  opened.push(body);
  return body;
}

/** Reads the actual published frame after dispatch. @throws {Error} If no binding was assembled. */
function frame(body: ReturnType<typeof open>): BodyProjection {
  const binding = bodyBindingOf(body.editor.prosemirrorState);
  if (binding === null) throw new Error('Expected the production body binding');
  expect(body.runtime.read().status).toBe('active');
  return binding.read();
}

afterEach(() => {
  act(() => {
    for (const body of opened.splice(0).reverse()) {
      body.editor.unmount();
      body.runtime.dispose();
      body.undo.manager.destroy();
      body.host.remove();
      body.doc.destroy();
    }
  });
});

it.each([-1, 1] as const)('keeps a normal split caret through unrelated peer input with affinity %s', (assoc) => {
  const local = open();
  const view = local.editor.prosemirrorView;
  act(() => view.dispatch(view.state.tr.insertText('ABCDEF')));
  act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.selection.from - 4))));
  let handled = false;
  act(() => { handled = view.someProp('handleKeyDown', (handler) => handler(view, new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))) === true; });
  expect(handled).toBe(true);
  const ids = [...frame(local).index.owners.keys()];
  expect(ids).toHaveLength(2);
  const afterSecond = frame(local).index.nodes.get(ids[1])!.to;
  const paragraph = view.state.schema.nodes['paragraph'].create(null, view.state.schema.text('peer'));
  act(() => view.dispatch(view.state.tr.insert(afterSecond, view.state.schema.nodes['blockContainer'].create({ id: 'peer' }, paragraph))));
  const firstId = ids[0];
  const at = frame(local).index.owners.get(firstId)!.contentTo;
  act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at))));
  const name = nameBodyPoint(frame(local).index, { kind: 'text', pos: at, assoc });
  expect.soft(resolveBodyPoint(frame(local).index, name)).toEqual({ status: 'resolved', pos: at, epoch: frame(local).epoch });

  const copy = new Y.Doc({ gc: false });
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(local.doc));
  const peer = open(copy);
  const target = frame(peer).index.owners.get('peer')!;
  act(() => peer.editor.prosemirrorView.dispatch(peer.editor.prosemirrorState.tr.insertText('!', target.contentTo)));
  act(() => Y.applyUpdate(local.doc, Y.encodeStateAsUpdate(peer.doc, Y.encodeStateVector(local.doc)), 'peer'));
  expect.soft(view.state.selection.toJSON()).toEqual({ type: 'text', anchor: at, head: at });
  local.undo.manager.stopCapturing();
  act(() => view.dispatch(view.state.tr.insertText('X')));
  const content = frame(local).doc;
  expect.soft(content.firstChild!.content.content.map((node) => node.firstChild!.textContent)).toEqual(['ABX', 'CDEF', 'peer!']);
  act(() => { local.editor.undo(); });
  expect(frame(local).doc.firstChild!.content.content.map((node) => node.firstChild!.textContent)).toEqual(['AB', 'CDEF', 'peer!']);
});
