// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A rename must reach the collaborators who can see our caret.
 *
 * The caret extension takes a `user` at construction, and this editor is
 * constructed once per document — it survives Space-tab switches by design, so
 * the identity configured on the extension is frozen at whatever was current
 * when the document was first opened. Nothing rebuilds it.
 *
 * What keeps the published identity true is `useCollabCaretPresence`, which
 * republishes the whole identity — not just the focus flag — whenever it
 * changes. That makes it load-bearing rather than incidental, and this is the
 * test that says so: without it a collaborator sees the old name for the rest
 * of the session, and every other test stays green.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { resolvePaletteHex, userPaletteHue } from '@web/lib/user-color';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

const HUE = userPaletteHue('u');

/** Build a caret identity with a given display name. */
function identity(name: string): {
  name: string;
  color: string;
  hue: ReturnType<typeof userPaletteHue>;
} {
  return { name, color: resolvePaletteHex(HUE), hue: HUE };
}

describe('our own caret identity', () => {
  afterEach(() => _resetDocumentEditorCacheForTests());

  it('is republished when the display name changes', async () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);

    const rendered = renderHook(
      ({ user }: { user: ReturnType<typeof identity> }) =>
        useDocumentEditor({
          doc,
          name: 'project-p/document-rename',
          caretProvider: { awareness },
          caretUser: user,
          hasEverSynced: true,
        }),
      { initialProps: { user: identity('Old Name') } },
    );
    await waitFor(() => expect(rendered.result.current).not.toBeNull());

    /** The name this client currently publishes to everyone else. */
    const published = (): string | undefined =>
      (awareness.getLocalState() as { user?: { name?: string } } | null)?.user
        ?.name;

    await waitFor(() => expect(published()).toBe('Old Name'));

    rendered.rerender({ user: identity('New Name') });

    // The editor is deliberately NOT rebuilt, so this can only come from the
    // presence hook republishing.
    await waitFor(() => expect(published()).toBe('New Name'));
  });
});
