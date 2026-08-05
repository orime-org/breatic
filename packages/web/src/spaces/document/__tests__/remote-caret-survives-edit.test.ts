// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
import { act } from 'react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { resolvePaletteHex, userPaletteHue } from '@web/lib/user-color';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { documentBodyFragment } from '@web/spaces/document/document-yjs';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

const HUE = userPaletteHue('local-user');
const CARET_USER = { name: 'Me', color: resolvePaletteHex(HUE), hue: HUE };
const REMOTE_CLIENT_ID = 4242;

describe('a collaborator caret', () => {
  afterEach(() => _resetDocumentEditorCacheForTests());

  it('is still there after we press Enter', async () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const body = documentBodyFragment(doc);
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText('shared sentence')]);
    body.insert(0, [para]);

    const rendered = renderHook(() =>
      useDocumentEditor({
        doc,
        name: 'project-p/document-carets',
        caretProvider: { awareness },
        caretUser: CARET_USER,
        hasEverSynced: true,
      }),
    );
    await waitFor(() => expect(rendered.result.current).not.toBeNull());
    const editor = rendered.result.current!.editor;

    // Only collaborators' carets are ever painted — the cursor plugin filters
    // out this client's own awareness state — so a count is unambiguous.
    /** How many collaborator carets are currently painted. */
    const caretCount = (): number =>
      (editor.view.dom as HTMLElement).querySelectorAll(
        '.collaboration-carets__caret',
      ).length;
    /** The name shown on the painted caret, for identifying whose it is. */
    const caretLabel = (): string =>
      (editor.view.dom as HTMLElement)
        .querySelector('.collaboration-carets__label')
        ?.textContent?.trim() ?? '';

    // Someone else joins and puts their caret in the paragraph. Awareness
    // carries positions in their JSON form — that is what the cursor plugin
    // reads back with `createRelativePositionFromJSON`.
    act(() => {
      const cursor = Y.relativePositionToJSON(
        Y.createRelativePositionFromTypeIndex(documentBodyFragment(doc), 0),
      );
      (awareness.states as Map<number, unknown>).set(REMOTE_CLIENT_ID, {
        user: { name: 'Them', color: '#ff0000' },
        cursor: { anchor: cursor, head: cursor },
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
      editor.commands.focus('end');
      editor.commands.splitBlock();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(caretCount()).toBe(1);
    expect(caretLabel()).toBe('Them');
  });
});
