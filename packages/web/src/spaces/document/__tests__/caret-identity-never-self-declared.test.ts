// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * This client never says who it is. Not once, not for a frame (#1886).
 *
 * The wire used to carry an identity because the browser put one there, and
 * the server checked it. Checking is the part that could never be made to
 * work: awareness legitimately relays what a client has learned about its
 * peers, so "this frame mentions somebody else's id" cannot tell a relay from
 * a forgery. The server already resolved this connection's user from the
 * credential it validated at the handshake, so it writes the id instead and
 * there is nothing left to check.
 *
 * What the browser is still entitled to state is `focused` — whether this
 * window is in the foreground. Nobody else can know it, and it says nothing
 * about who is behind the window.
 *
 * ## Why the second case reads every value, not the settled one
 *
 * The caret extension writes its `user` option into awareness when its plugin
 * starts, and `useCollabCaretPresence` overwrites that field a moment later
 * with the focus flag. So a regression that hands the extension an identity
 * again leaves NO TRACE in the settled state — the first assertion below would
 * sit green while every frame in that window carried an id.
 *
 * That seeded write is also why the second case asks for "nothing with a
 * value" rather than "no fields at all": the extension's own default is
 * `{name: null, color: null}` and it cannot be cleared from the call site,
 * because `configure` deep-merges into the defaults. Nulls state nothing and
 * the server replaces the field before it reaches anyone, so what is worth
 * pinning is that no field ever carries a value.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

describe('our own caret identity', () => {
  afterEach(() => _resetDocumentEditorCacheForTests());

  it('publishes no identity at all, only the window-focus flag', async () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);

    const rendered = renderHook(() =>
      useDocumentEditor({
        doc,
        name: 'project-p/document-identity',
        caretProvider: { awareness },
        hasEverSynced: true,
      }),
    );
    await waitFor(() => expect(rendered.result.current).not.toBeNull());

    /** Whatever this client currently publishes about itself. */
    const published = (): Record<string, unknown> | undefined =>
      (awareness.getLocalState() as { user?: Record<string, unknown> } | null)
        ?.user;

    await waitFor(() => expect(published()).not.toBeUndefined());

    const fields = Object.keys(published() ?? {});
    // `focused` is presence, not identity — it describes what this window is
    // doing right now and cannot be looked up from anywhere else.
    expect(fields.filter((f) => f !== 'focused')).toEqual([]);
    expect(published()).not.toHaveProperty('id');
    expect(published()).not.toHaveProperty('name');
    expect(published()).not.toHaveProperty('color');
    expect(published()).not.toHaveProperty('hue');
    expect(published()).not.toHaveProperty('avatarUrl');
  });

  it('carries no id in any state it ever publishes, not just the settled one', async () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);

    // Subscribed BEFORE the editor exists, so the extension's own first write
    // is recorded too. That write is the one a settled-state assertion misses.
    const everPublished: Array<Record<string, unknown> | undefined> = [];
    const record = (): void => {
      everPublished.push(
        (awareness.getLocalState() as {
          user?: Record<string, unknown>;
        } | null)?.user,
      );
    };
    awareness.on('update', record);

    const rendered = renderHook(() =>
      useDocumentEditor({
        doc,
        name: 'project-p/document-every-frame',
        caretProvider: { awareness },
        hasEverSynced: true,
      }),
    );
    await waitFor(() => expect(rendered.result.current).not.toBeNull());
    await waitFor(() =>
      expect(everPublished.some((u) => u !== undefined)).toBe(true),
    );

    awareness.off('update', record);

    // Across every frame: no id, ever, and nothing else carrying a value. The
    // one thing this client may state is `focused`, which is a boolean about
    // the window rather than a claim about the person behind it.
    for (const user of everPublished) {
      if (user === undefined) continue;
      expect(user).not.toHaveProperty('id');
      const stated = Object.entries(user).filter(
        ([field, value]) => field !== 'focused' && value !== null,
      );
      expect(stated).toEqual([]);
    }
  });
});
