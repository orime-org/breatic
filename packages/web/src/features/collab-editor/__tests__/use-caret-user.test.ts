// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The identity this client hands to the caret extension.
 *
 * This is the source of what lands in awareness, so it is where "the wire
 * carries the id and nothing else" (#1882) has to be enforced. The
 * document-space test that checks the published state can only prove the
 * editor publishes what it is given; what it is given is decided here.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useCaretUser } from '@web/features/collab-editor/use-caret-user';
import { useCurrentUserStore } from '@web/stores';

/** Seed the store with a signed-in user. */
function signIn(id: string, name: string): void {
  useCurrentUserStore.getState().setUser({
    id,
    name,
    email: `${id}@example.com`,
    avatarUrl: 'https://cdn/avatar.png',
    personalStudio: { name, slug: id, avatarUrl: 'https://cdn/avatar.png' },
  });
}

describe('useCaretUser', () => {
  beforeEach(() => {
    useCurrentUserStore.setState({ user: null, role: null });
  });

  it('carries the user id and nothing else', () => {
    signIn('user-42', 'Alice');
    const { result } = renderHook(() => useCaretUser());
    // Exactly one key. Not "id plus a name we happen to have handy": every
    // extra field is one more thing two tabs of one account can disagree
    // about, which is the bug this replaced.
    expect(result.current).toEqual({ id: 'user-42' });
  });

  it('leaks neither the display name nor the avatar the store holds', () => {
    signIn('user-42', 'Alice');
    const { result } = renderHook(() => useCaretUser());
    const published = JSON.stringify(result.current);
    expect(published).not.toContain('Alice');
    expect(published).not.toContain('cdn/avatar.png');
  });

  it('is null until a user is resolved (the caret layer stays unmounted)', () => {
    const { result } = renderHook(() => useCaretUser());
    expect(result.current).toBeNull();
  });

  it('keeps a stable reference across renders while the id is unchanged', () => {
    // The identity object is a dependency of the caret extension and of the
    // presence effect; a new object every render would re-publish awareness on
    // every keystroke.
    signIn('user-42', 'Alice');
    const { result, rerender } = renderHook(() => useCaretUser());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('does not change when only the display name changes', () => {
    // A rename must not disturb the wire at all — peers read the new name off
    // the roster, and re-publishing would only give two tabs something to
    // disagree about.
    //
    // The SAME OBJECT, not an equal one. Every effect that publishes presence
    // or mounts a caret extension keys on this reference, so an implementation
    // handing back a fresh `{ id }` per store write re-publishes awareness and
    // re-runs all of them on every rename — while a structural comparison sits
    // there green, since the contents are of course still equal.
    signIn('user-42', 'Alice');
    const { result, rerender } = renderHook(() => useCaretUser());
    const first = result.current;
    signIn('user-42', 'Alice Wu');
    rerender();
    expect(result.current).toBe(first);
  });
});
