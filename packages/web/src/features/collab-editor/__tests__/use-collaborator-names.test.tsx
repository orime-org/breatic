// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Resolving a collaborator's name from the project roster (#1882).
 *
 * The caret renderer runs inside ProseMirror, outside React, and is handed a
 * resolver rather than data. Two properties matter and both are tested here:
 * the lookup itself, and the resolver's reference staying stable — it is a
 * dependency of the caret extension, which is built once per document and
 * never rebuilt, so a new function every render would be silently ignored by
 * everything downstream while looking like it works.
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';

import type { Member } from '@web/data/api/members';
import {
  resolveNameFrom,
  useCollaboratorNamesFrom,
  useResolverRef,
} from '@web/features/collab-editor/use-collaborator-names';

/** A roster row. */
function member(userId: string, name: string): Member {
  return { id: userId, userId, name, email: `${userId}@x.com`, role: 'editor' };
}

const ROSTER: Member[] = [member('u1', 'Alice'), member('u2', 'Bo')];

describe('resolveNameFrom', () => {
  it('finds a member by user id', () => {
    expect(resolveNameFrom(ROSTER, 'u2')).toBe('Bo');
  });

  it('returns null for someone the roster does not list', () => {
    // Happens for real: the roster is fetched on entering the project, and
    // somebody added afterwards shows up in awareness before the re-fetch
    // lands.
    expect(resolveNameFrom(ROSTER, 'u3')).toBeNull();
  });

  it('treats a blank name as unresolved rather than as a name', () => {
    // The roster merge fills `name: profile?.name ?? ''` while the profile
    // query is in flight, so a listed member can carry an empty name. Passing
    // that through would paint an empty label — a coloured box with nothing in
    // it — instead of the bare caret line.
    expect(resolveNameFrom([member('u1', '')], 'u1')).toBeNull();
    expect(resolveNameFrom([member('u1', '   ')], 'u1')).toBeNull();
  });

  it('returns null against an empty roster', () => {
    expect(resolveNameFrom([], 'u1')).toBeNull();
  });
});

describe('useResolverRef', () => {
  it('keeps one reference while the roster changes underneath it', () => {
    const { result, rerender } = renderHook(
      ({ members }: { members: Member[] }) => useResolverRef(members),
      { initialProps: { members: ROSTER } },
    );
    const first = result.current;
    rerender({ members: [...ROSTER, member('u3', 'Cai')] });
    expect(result.current).toBe(first);
  });

  it('resolves against the CURRENT roster through that stable reference', () => {
    // The whole point: the extension holds the function it was given at
    // construction, so that function has to see later data.
    const { result, rerender } = renderHook(
      ({ members }: { members: Member[] }) => useResolverRef(members),
      { initialProps: { members: [] as Member[] } },
    );
    const resolve = result.current;
    expect(resolve('u1')).toBeNull();

    rerender({ members: ROSTER });
    expect(resolve('u1')).toBe('Alice');
  });

  it('reflects a rename through the same reference', () => {
    const { result, rerender } = renderHook(
      ({ members }: { members: Member[] }) => useResolverRef(members),
      { initialProps: { members: ROSTER } },
    );
    const resolve = result.current;
    expect(resolve('u1')).toBe('Alice');

    rerender({ members: [member('u1', 'Alice Wu'), member('u2', 'Bo')] });
    expect(resolve('u1')).toBe('Alice Wu');
  });
});

describe('useCollaboratorNamesFrom — the bundle the project page publishes', () => {
  it('hands back a NEW bundle when the roster changes', () => {
    // This is the whole repaint trigger. The bundle goes into context, and the
    // effect that patches names onto carets already on screen depends on it —
    // so a bundle whose identity never moves means a name that lands after a
    // caret was drawn never reaches it, which is the case this feature exists
    // for. Freezing it looks like a harmless memo tidy-up and is not.
    const { result, rerender } = renderHook(
      ({ members }: { members: Member[] }) => useCollaboratorNamesFrom(members),
      { initialProps: { members: [member('u1', 'Alice')] } },
    );
    const first = result.current;

    rerender({ members: [member('u1', 'Alice'), member('u2', 'Bo')] });
    expect(result.current).not.toBe(first);
    expect(result.current.resolve('u2')).toBe('Bo');
  });

  it('hands back the SAME bundle when the roster array does not move', () => {
    // The other side of it: re-rendering for an unrelated reason must not
    // churn the bundle, or every editor below re-runs its name effect on every
    // keystroke elsewhere on the page.
    const roster = [member('u1', 'Alice')];
    const { result, rerender } = renderHook(
      ({ members }: { members: Member[] }) => useCollaboratorNamesFrom(members),
      { initialProps: { members: roster } },
    );
    const first = result.current;

    rerender({ members: roster });
    expect(result.current).toBe(first);
  });

  it('keeps the resolver itself stable even when the bundle is replaced', () => {
    // Both properties at once, because they pull in opposite directions and
    // the editors depend on exactly this combination: the bundle moves so the
    // repaint fires, the resolver does not so the editor is not rebuilt.
    const { result, rerender } = renderHook(
      ({ members }: { members: Member[] }) => useCollaboratorNamesFrom(members),
      { initialProps: { members: [member('u1', 'Alice')] } },
    );
    const first = result.current;

    rerender({ members: [member('u1', 'Alice'), member('u2', 'Bo')] });
    expect(result.current).not.toBe(first);
    expect(result.current.resolve).toBe(first.resolve);
  });
});
