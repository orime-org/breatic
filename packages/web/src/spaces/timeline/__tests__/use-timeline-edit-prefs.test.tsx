// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** The editing user's magnet, snap and linkage switches (inner#1708 E13, design §2.5, §5.3). */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readUserPreferences, writeUserPreference } from '@web/lib/user-preferences-storage';
import { STORAGE_KEYS } from '@web/lib/storage-keys';
import { useCurrentUserStore } from '@web/stores';
import { useTimelineEditPrefs } from '@web/spaces/timeline/use-timeline-edit-prefs';

const ALICE = 'user-alice';
const BOB = 'user-bob';

/**
 * Sign an account in without the analytics side effects of `setUser`.
 * @param id - The account id, or null to sign out.
 * @throws {never} Never.
 */
function signIn(id: string | null): void {
  useCurrentUserStore.setState({
    user: id === null ? null : { id, name: id, email: `${id}@e.com`, personalStudio: { name: id, slug: id, avatarUrl: null }, membershipTier: 'base' },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  signIn(ALICE);
});
afterEach(() => {
  signIn(null);
  vi.restoreAllMocks();
});

describe('useTimelineEditPrefs', () => {
  it('starts with all three switches on', () => {
    const { result } = renderHook(() => useTimelineEditPrefs());
    expect(result.current).toMatchObject({ magnet: true, snap: true, linkage: true });
  });

  it('reads what this account stored', () => {
    writeUserPreference(ALICE, { timelineMagnet: false, timelineSnap: true, timelineLinkage: false });
    const { result } = renderHook(() => useTimelineEditPrefs());
    expect(result.current).toMatchObject({ magnet: false, snap: true, linkage: false });
  });

  it('writes a change to the signed-in account only', () => {
    const { result } = renderHook(() => useTimelineEditPrefs());
    act(() => result.current.set({ snap: false }));
    expect(result.current).toMatchObject({ magnet: true, snap: false, linkage: true });
    expect(readUserPreferences(ALICE).timelineSnap).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.userPreferences) ?? '{}')).not.toHaveProperty(BOB);
  });

  it('switches to the other account\'s values when the account changes', () => {
    writeUserPreference(ALICE, { timelineMagnet: false });
    const { result } = renderHook(() => useTimelineEditPrefs());
    expect(result.current.magnet).toBe(false);
    act(() => signIn(BOB));
    expect(result.current).toMatchObject({ magnet: true, snap: true, linkage: true });
    act(() => result.current.set({ linkage: false }));
    act(() => signIn(ALICE));
    expect(result.current).toMatchObject({ magnet: false, snap: true, linkage: true });
    expect(readUserPreferences(BOB).timelineLinkage).toBe(false);
  });

  it('reads an unusable stored value as on', () => {
    window.localStorage.setItem(STORAGE_KEYS.userPreferences, JSON.stringify({ [ALICE]: { timelineMagnet: 'off', timelineSnap: 0, timelineLinkage: null } }));
    const { result } = renderHook(() => useTimelineEditPrefs());
    expect(result.current).toMatchObject({ magnet: true, snap: true, linkage: true });
  });

  it('keeps the value in memory when storage refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    const { result } = renderHook(() => useTimelineEditPrefs());
    act(() => result.current.set({ magnet: false }));
    expect(result.current.magnet).toBe(false);
  });
});
