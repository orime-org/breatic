// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What this client publishes about itself is its user id, and nothing else.
 *
 * This file used to assert the opposite half of the same problem: that a
 * rename was RE-published, because the caret extension takes its `user` at
 * construction and this editor is built once per document (it survives
 * Space-tab switches by design), so a name frozen at construction would stay
 * frozen for the session. `useCollabCaretPresence` re-publishing the identity
 * was what kept it true.
 *
 * #1882 removed the problem instead of maintaining the fix: identity is no
 * longer broadcast at all. Peers resolve a name from the project member
 * roster — server data, current by construction — and derive the colour from
 * the id. A rename needs no re-publish because there is nothing about the name
 * to publish, and two tabs of one account can no longer disagree about it.
 *
 * So the invariant worth pinning flipped. It is now: the wire carries the id
 * (plus genuinely ephemeral presence like focus), and never a display name,
 * colour or avatar. A regression that starts publishing identity again — the
 * obvious "fix" for a caret that shows up unnamed — trips here.
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
        caretUser: { id: 'user-42' },
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
    // Focus is the only thing the browser is entitled to state here. Who this
    // caret belongs to is written by the server from the credential this
    // connection presented, so an id from us is a claim we cannot back (#1886).
    expect(fields.filter((f) => f !== 'focused')).toEqual([]);
    expect(published()).not.toHaveProperty('id');
    expect(published()).not.toHaveProperty('name');
    expect(published()).not.toHaveProperty('color');
    expect(published()).not.toHaveProperty('hue');
    expect(published()).not.toHaveProperty('avatarUrl');
  });

  it('a rename changes nothing on the wire, because nothing about the person is on it', async () => {
    // The point of the redesign: the name is not on the wire, so renaming
    // cannot desync it. Peers pick the new name up from the roster instead.
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);

    const rendered = renderHook(
      ({ user }: { user: { id: string } }) =>
        useDocumentEditor({
          doc,
          name: 'project-p/document-rename',
          caretProvider: { awareness },
          caretUser: user,
          hasEverSynced: true,
        }),
      { initialProps: { user: { id: 'user-42' } } },
    );
    await waitFor(() => expect(rendered.result.current).not.toBeNull());

    const published = (): Record<string, unknown> | undefined =>
      (awareness.getLocalState() as { user?: Record<string, unknown> } | null)
        ?.user;
    await waitFor(() => expect(published()).not.toBeUndefined());
    const before = JSON.stringify(published());

    // Same person, new object identity — the shape a rename produces upstream,
    // since `toCurrentUser` builds a fresh store user on every write.
    rendered.rerender({ user: { id: 'user-42' } });

    await waitFor(() => expect(JSON.stringify(published())).toBe(before));
  });
});
