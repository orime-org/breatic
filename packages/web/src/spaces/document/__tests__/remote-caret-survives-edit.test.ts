// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A collaborator's caret must survive our own structural edits.
 *
 * `@tiptap/y-tiptap` drops every remote decoration on a local structural
 * transaction — pressing Enter, pasting blocks, deleting across a paragraph
 * boundary — because the ProseMirror document leads the Yjs mapping through
 * such an edit and a caret left at its old position would be painted somewhere
 * wrong. It then waits for the collaborator to publish a new cursor.
 *
 * That wait never ends on its own. The collaborator has no idea our document
 * changed shape, and an idle client's awareness heartbeats are deep-equal, so
 * they surface as `update` and never as the `change` the cursor plugin listens
 * for. In a document, Enter is the most common keystroke there is, so without
 * the refresh extension everyone else's caret blanks the moment we start a new
 * paragraph, and stays blank for as long as they sit still.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { act, createElement } from 'react';
import type * as React from 'react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { CollaboratorNamesProvider } from '@web/features/collab-editor/collaborator-names-context';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
} from '@web/spaces/document/document-editor-cache';
import { documentBodyFragment, importCurrentDocumentBody, DOCUMENT_BODY_FORMAT, DOCUMENT_BODY_FORMAT_VERSION } from '@breatic/shared';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

const REMOTE_CLIENT_ID = 4242;

describe('a collaborator caret', () => {
  afterEach(() => _resetDocumentEditorCacheForTests());

  it('is still there after we press Enter', async () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const body = documentBodyFragment(doc);
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText('shared sentence')]);
    const holder = new Y.XmlElement('blockContainer');
    holder.insert(0, [para]);
    const group = new Y.XmlElement('blockGroup');
    group.insert(0, [holder]);
    body.insert(0, [group]);
    importCurrentDocumentBody(doc, 'project-p/document-carets');

    const rendered = renderHook(
      () =>
        useDocumentEditor({
          doc,
          name: 'project-p/document-carets',
          caretProvider: { awareness },
          readWho: () => ({ role: 'editor', viewerId: 'u1' }),
        }),
      {
        // The name is resolved from the roster now (#1882), not published by
        // the peer, and it reaches the editor through context rather than
        // through an argument — so the caret needs a provider above it to have
        // a label at all.
        wrapper: ({ children }: { children: React.ReactNode }) =>
          createElement(
            CollaboratorNamesProvider,
            {
              value: {
                resolve: (userId: string) =>
                  userId === 'u-them' ? 'Them' : null,
                members: [],
              },
            },
            children,
          ),
      },
    );
    await waitFor(() => expect(rendered.result.current).not.toBeNull());
    const handle = rendered.result.current!;
    // Carets are painted by a plugin's decorations, and a plugin view is what
    // mounting builds.
    const container = document.createElement('div');
    document.body.appendChild(container);
    adoptDocumentEditor(handle, container);
    const editor = handle.editor;

    // Only collaborators' carets are ever painted — the cursor plugin filters
    // out this client's own awareness state — so a count is unambiguous.
    /** How many collaborator carets are currently painted. */
    const caretCount = (): number =>
      container.querySelectorAll('.collaboration-carets__caret').length;
    /** The name shown on the painted caret, for identifying whose it is. */
    const caretLabel = (): string =>
      container
        .querySelector('.collaboration-carets__label')
        ?.textContent?.trim() ?? '';

    // The peer names the body's start, matching the original root-relative
    // cursor, in the current versioned awareness protocol.
    act(() => {
      const point = { version: 1, document: 'project-p/document-carets', kind: 'bodyEdge', edge: 'start' };
      (awareness.states as Map<number, unknown>).set(REMOTE_CLIENT_ID, {
        user: { id: 'u-them' },
        cursor: { format: DOCUMENT_BODY_FORMAT, version: DOCUMENT_BODY_FORMAT_VERSION,
          document: 'project-p/document-carets', selection: { version: 1, document: 'project-p/document-carets',
            kind: 'text', anchor: point, head: point } },
      });
      awareness.emit('change', [
        { added: [REMOTE_CLIENT_ID], updated: [], removed: [] },
        'remote',
      ]);
    });
    await waitFor(() => expect(caretCount()).toBe(1));
    expect(caretLabel()).toBe('Them');

    // We start a new paragraph. They have not moved and will not: an idle
    // client's heartbeats are deep-equal and never reach the cursor plugin.
    act(() => {
      editor.replaceBlocks(editor.document, [
        { type: 'paragraph', content: 'ours' },
        { type: 'paragraph' },
      ] as never);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(caretCount()).toBe(1);
    expect(caretLabel()).toBe('Them');
  });
});
