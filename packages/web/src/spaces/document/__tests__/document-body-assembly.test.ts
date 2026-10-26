// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { createExtension } from '@blocknote/core';
import { withCollaboration } from '@blocknote/core/yjs';
import { Plugin } from '@tiptap/pm/state';
import * as Y from 'yjs';
import type * as CollaborationModule from '@blocknote/core/yjs';
import { documentBodyFragment, readBodyTree } from '@breatic/shared/document-body';

import { buildDocumentEditor, type DocumentEditorOptions } from '@web/spaces/document/build-document-editor';
import { bodyInlineOccurrences } from '@web/spaces/document/document-body-provenance';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import { markdownBlocks } from '@web/spaces/document/document-markdown';
import { cleanupCodecFixtures, codecFixture, codecNativeTokens, codecParagraph } from '@web/spaces/document/__tests__/document-body-codec-fixtures';

vi.mock('@blocknote/core/yjs', async (importOriginal) => {
  const actual = await importOriginal<typeof CollaborationModule>();
  return { ...actual, withCollaboration: vi.fn(actual.withCollaboration) };
});

const editors: ReturnType<typeof buildDocumentEditor>[] = [];
const histories: Y.UndoManager[] = [];
const hosts: HTMLElement[] = [];

beforeEach(() => vi.clearAllMocks());

afterEach(() => {
  vi.restoreAllMocks();
  act(() => {
    editors.splice(0).forEach((editor) => editor.unmount());
    histories.splice(0).forEach((history) => history.destroy());
    hosts.splice(0).forEach((host) => host.remove());
    cleanupCodecFixtures();
  });
});

/** Opens the real factory with the approved records handle wiring. */
function open(extensions: DocumentEditorOptions['extensions'] = []): {
  doc: Y.Doc;
  editor: ReturnType<typeof buildDocumentEditor>;
  runtime: ReturnType<typeof createDocumentBodyRuntime>;
  history: Y.UndoManager;
  origin: object;
  before: Uint8Array;
} {
  const doc = codecFixture([{ id: 'A', text: 'AB' }]);
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const origin = {};
  const history = new Y.UndoManager(doc, { trackedOrigins: new Set([origin]) });
  histories.push(history);
  const before = Y.encodeStateAsUpdate(doc);
  const options = {
    fragment: documentBodyFragment(doc), extensions,
    body: { document: 'document:assembly', runtime, history, origin },
  };
  const editor = buildDocumentEditor(options);
  editors.push(editor);
  return { doc, editor, runtime, history, origin, before };
}

/** Mounts the same editor without rebuilding its body state. */
function mount(editor: ReturnType<typeof buildDocumentEditor>): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  act(() => editor.mount(host));
}

/** Reads native content and identities independently of the binding's published frame. */
function native(doc: Y.Doc): { text: string; ids: readonly string[] } {
  const read = readBodyTree(doc);
  if (read.status !== 'ready') throw new Error(`Incomplete assembly fixture:${read.status}`);
  return {
    text: read.view.owners.map((owner) => owner.units.map((unit) => String(unit.value)).join('')).join(''),
    ids: read.view.owners.flatMap((owner) => owner.units.map((unit) => unit.id)),
  };
}

describe('records body production assembly', () => {
  it('constructs the initial records projection before mount without changing the shared source', () => {
    const { doc, editor, before, history } = open();
    const expected = editor.pmSchema.node('doc', null, editor.pmSchema.node('blockGroup', null, codecParagraph(editor.pmSchema, 'A', 'AB')));
    expect(editor.prosemirrorState.doc.toJSON()).toEqual(expected.toJSON());
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    mount(editor);
    expect(editor.prosemirrorState.doc.toJSON()).toEqual(expected.toJSON());
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(history.undoStack).toHaveLength(0);
  });

  it('keeps the XML collaboration factories out of records construction', () => {
    const { editor } = open();
    mount(editor);
    expect(withCollaboration).not.toHaveBeenCalled();
    const keys = editor.prosemirrorState.plugins.map((plugin) => String((plugin as unknown as { key: string }).key));
    expect(keys.some((key) => key.includes('documentBodyBinding'))).toBe(true);
    expect(keys.some((key) => key.includes('y-sync') || key.includes('y-undo') || key === 'history$')).toBe(false);
    expect(editor.getExtension('ySync')).toBeUndefined();
    expect(editor.getExtension('yUndo')).toEqual(expect.objectContaining({ key: 'yUndo' }));
    expect(editor.getExtension('yPositionMapping')).toEqual(expect.objectContaining({ key: 'yPositionMapping' }));
  });

  it('commits the real root and append loop as one native user history item', () => {
    const append = createExtension(() => ({
      key: 'assemblyAcceptedAppend',
      prosemirrorPlugins: [new Plugin({ appendTransaction: (transactions, _old, state) => (
        transactions.some((transaction) => transaction.getMeta('assembly-root') === true)
          ? state.tr.insertText('!', state.doc.content.size - 3)
          : null
      ) })],
    }));
    const { doc, editor, origin, history } = open([append()]);
    mount(editor);
    const beforeIds = codecNativeTokens(doc, 'A', 2);
    let userUpdates = 0;
    doc.on('update', (_update, actualOrigin) => { if (actualOrigin === origin) userUpdates += 1; });
    const view = editor.prosemirrorView;
    const first = bodyInlineOccurrences(view.state.doc)[0];
    expect(view.state.doc.textContent).toBe('AB');
    if (first === undefined) throw new Error('The initial projection has no native text');
    act(() => view.dispatch(view.state.tr.insertText('X', first.pos + 1).setMeta('assembly-root', true)));
    expect(view.state.doc.textContent).toBe('AXB!');
    expect(native(doc).text).toBe('AXB!');
    expect(native(doc).ids.filter((id) => beforeIds.includes(id))).toEqual(beforeIds);
    expect(userUpdates).toBe(1);
    expect(history.undoStack).toHaveLength(1);
    act(() => { history.undo(); });
    expect(view.state.doc.textContent).toBe('AB');
    expect(native(doc).text).toBe('AB');
    act(() => { history.redo(); });
    expect(view.state.doc.textContent).toBe('AXB!');
  });

  it('applies one runtime lock independently of the editable preference', () => {
    const { doc, editor, runtime } = open();
    mount(editor);
    const before = Y.encodeStateAsUpdate(doc);
    const previous = editor.prosemirrorState.doc;
    act(() => runtime.wait(['fact:pending']));
    expect(editor.isEditable).toBe(false);
    act(() => { editor.isEditable = false; editor.isEditable = true; });
    expect(editor.isEditable).toBe(false);
    act(() => editor.prosemirrorView.dispatch(editor.prosemirrorState.tr.insertText('blocked', 3)));
    expect(editor.prosemirrorState.doc.toJSON()).toEqual(previous.toJSON());
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    act(() => runtime.resume());
    expect(editor.isEditable).toBe(true);
  });
});

describe('independent body parsing assembly', () => {
  it('parses markdown and destroys its temporary document without constructing collaboration', async () => {
    const destroyed = vi.spyOn(Y.Doc.prototype, 'destroy');
    const result = await markdownBlocks('Hello');
    expect(result.map((block) => block.text)).toEqual(['Hello']);
    expect(withCollaboration).not.toHaveBeenCalled();
    expect(destroyed).toHaveBeenCalledTimes(1);
  });
});
