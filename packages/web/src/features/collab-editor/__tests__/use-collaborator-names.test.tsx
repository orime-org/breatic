// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
