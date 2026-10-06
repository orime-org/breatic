// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { readUserPreferences, writeUserPreference } from '@web/lib/user-preferences-storage';
import { useRailCollapse } from '@web/pages/studio/rail/use-rail-collapse';
import { useCurrentUserStore } from '@web/stores/current-user';

const ALICE = 'user-alice';
const BOB = 'user-bob';

/**
 * Sign an account in, the way `ProtectedRoute` guarantees one before the
 * Studio rail renders.
 * @param id - The account id.
 */
function signIn(id: string): void {
  useCurrentUserStore.setState({
    user: { id, name: id, email: `${id}@example.com`, personalStudio: null, membershipTier: 'base' },
  });
}

describe('useRailCollapse', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signIn(ALICE);
  });

  it('defaults to expanded (not collapsed)', () => {
    const { result } = renderHook(() => useRailCollapse('mine'));
    expect(result.current.collapsed).toBe(false);
  });

  it('toggles and stores the choice for the signed-in account', () => {
    const { result } = renderHook(() => useRailCollapse('mine'));

    act(() => result.current.toggle());

    expect(result.current.collapsed).toBe(true);
    expect(readUserPreferences(ALICE).railCollapsed).toEqual({
      personal: false,
      mine: true,
      joined: false,
    });
  });

  it('keeps the other sections when one is toggled', () => {
    writeUserPreference(ALICE, { railCollapsed: { personal: true, mine: false, joined: true } });
    const { result } = renderHook(() => useRailCollapse('mine'));

    act(() => result.current.toggle());

    expect(readUserPreferences(ALICE).railCollapsed).toEqual({
      personal: true,
      mine: true,
      joined: true,
    });
  });

  it('reads what this account stored on a fresh mount', () => {
    writeUserPreference(ALICE, { railCollapsed: { personal: false, mine: false, joined: true } });

    const { result } = renderHook(() => useRailCollapse('joined'));

    expect(result.current.collapsed).toBe(true);
  });

  it('does not show another account the sections it collapsed', () => {
    writeUserPreference(ALICE, { railCollapsed: { personal: true, mine: true, joined: true } });
    signIn(BOB);

    const { result } = renderHook(() => useRailCollapse('personal'));

    expect(result.current.collapsed).toBe(false);
  });
});
