// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { documentBodyFragment, readBodyTree } from '@breatic/shared/document-body';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import type { DocumentBodyRuntime } from '@web/spaces/document/document-body-runtime-types';
import { cleanupCodecFixtures, codecFixture, codecParagraph } from '@web/spaces/document/__tests__/document-body-codec-fixtures';

vi.mock('@breatic/shared/document-body', async (original) => {
  const actual = await original<typeof import('@breatic/shared/document-body')>();
  return { ...actual, readBodyTree: vi.fn(actual.readBodyTree) };
});

interface OpenBody {
  readonly doc: Y.Doc;
  readonly editor: ReturnType<typeof buildDocumentEditor>;
  readonly runtime: DocumentBodyRuntime;
  readonly history: Y.UndoManager;
  readonly origin: object;
  readonly host: HTMLElement;
}

const opened: OpenBody[] = [];

/** Mounts the real factory with independently seeded content and native history. @throws {Error} If assembly fails. */
function open(text: string): OpenBody {
  const doc = codecFixture([{ id: 'A', text }]);
  const origin = {};
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const history = new Y.UndoManager(doc, { trackedOrigins: new Set([origin]) });
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), body: { document: 'document:derived-reads', origin, runtime, history } });
  const host = document.createElement('div');
  document.body.append(host);
  act(() => editor.mount(host));
  const body = { doc, editor, runtime, history, origin, host };
  opened.push(body);
  return body;
}

/** Appends one actual user character and counts complete decodes across its real binding. @throws {Error} If the source or binding is unavailable. */
function appendAndCount(text: string): number {
  const body = open(text);
  const view = body.editor.prosemirrorView;
  const binding = bodyBindingOf(view.state)!;
  const at = binding.read().index.owners.get('A')!.contentTo;
  let userUpdates = 0;
  body.doc.on('update', (_bytes, origin) => { if (origin === body.origin) userUpdates += 1; });
  vi.mocked(readBodyTree).mockClear();
  act(() => view.dispatch(view.state.tr.insertText('X', at)));
  expect(readBodyTree).toHaveBeenCalledWith(body.doc);
  const reads = vi.mocked(readBodyTree).mock.calls.length;
  expect(body.runtime.read().status).toBe('active');
  expect(view.state.doc.toJSON()).toEqual(body.editor.pmSchema.node('doc', null,
    body.editor.pmSchema.node('blockGroup', null, codecParagraph(body.editor.pmSchema, 'A', text + 'X')),
  ).toJSON());
  expect(userUpdates).toBe(1);
  expect(body.history.undoStack).toHaveLength(1);
  return reads;
}

afterEach(() => {
  act(() => {
    for (const body of opened.splice(0)) {
      body.editor.unmount();
      body.runtime.dispose();
      body.history.destroy();
      body.host.remove();
    }
    cleanupCodecFixtures();
  });
  vi.clearAllMocks();
});

describe('revision-derived reads through the actual body factory', () => {
  it('performs the same number of complete decodes for one appended character at different paragraph lengths', () => {
    const short = appendAndCount('a'.repeat(16));
    const long = appendAndCount('a'.repeat(128));
    expect(long).toBe(short);
  });

  it('publishes current content and marks after native source revisions within the same accepted batch', () => {
    const body = open('AB');
    const view = body.editor.prosemirrorView;
    const binding = bodyBindingOf(view.state)!;
    const owner = binding.read().index.owners.get('A')!;
    act(() => view.dispatch(view.state.tr.insertText('X', owner.contentTo)
      .addMark(owner.contentFrom, owner.contentFrom + 1, body.editor.pmSchema.mark('bold'))));
    expect(body.runtime.read().status).toBe('active');
    const schema = body.editor.pmSchema;
    expect(view.state.doc.toJSON()).toEqual(schema.node('doc', null, schema.node('blockGroup', null,
      schema.node('blockContainer', { id: 'A' }, schema.node('paragraph', null, [
        schema.text('A', [schema.mark('bold')]), schema.text('BX'),
      ])),
    )).toJSON());
    expect(body.history.undoStack).toHaveLength(1);
    act(() => { body.history.undo(); });
    expect(view.state.doc.toJSON()).toEqual(schema.node('doc', null,
      schema.node('blockGroup', null, codecParagraph(schema, 'A', 'AB')),
    ).toJSON());
    act(() => { body.history.redo(); });
    expect(view.state.doc.textContent).toBe('ABX');
    expect(view.state.doc.nodeAt(owner.contentFrom)!.marks.map((mark) => mark.type.name)).toEqual(['bold']);
  });
});
