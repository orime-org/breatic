// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Leaving a document must take this client's caret with it.
 *
 * Normally the cursor plugin withdraws its own caret when the editor is torn
 * down. Ours is not torn down: it is cached per document so that a Space-tab
 * switch keeps the undo stack and the selection, which means the plugin's
 * teardown never runs on a tab switch at all.
 *
 * So the withdrawal has to happen where the USER left, not where the editor
 * did. Without it, every collaborator goes on seeing this person's caret parked
 * in a document they closed — indefinitely, since an idle client publishes
 * nothing that would correct it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { resolvePaletteHex, userPaletteHue } from '@web/lib/user-color';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { documentBodyFragment } from '@web/spaces/document/document-yjs';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

const HUE = userPaletteHue('u');
const CARET_USER = { name: 'Me', color: resolvePaletteHex(HUE), hue: HUE };

describe('this client caret', () => {
  afterEach(() => _resetDocumentEditorCacheForTests());

  it('is withdrawn when the document body unmounts', async () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText('some text to park a caret in')]);
    documentBodyFragment(doc).insert(0, [para]);

    const rendered = renderHook(() =>
      useDocumentEditor({
        doc,
        name: 'project-p/document-leave',
        caretProvider: { awareness },
        caretUser: CARET_USER,
        hasEverSynced: true,
      }),
    );
    await waitFor(() => expect(rendered.result.current).not.toBeNull());
    // Publish a cursor the way the editor does once it has focus.
    awareness.setLocalStateField('cursor', { anchor: {}, head: {} });
    expect(
      (awareness.getLocalState() as { cursor?: unknown } | null)?.cursor,
    ).not.toBeNull();

    rendered.unmount();

    expect(
      (awareness.getLocalState() as { cursor?: unknown } | null)?.cursor,
    ).toBeNull();
  });
});
