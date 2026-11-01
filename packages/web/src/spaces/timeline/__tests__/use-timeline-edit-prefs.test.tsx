// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** The editing user's magnet, snap and linkage switches (inner#1708 E13, design §2.5, §5.3). */

import * as React from 'react';
import { act, render, renderHook } from '@testing-library/react';
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

  it('shares one account\'s switches between two mounted editors without a remount', () => {
    const tabA = renderHook(() => useTimelineEditPrefs());
    const tabB = renderHook(() => useTimelineEditPrefs());
    act(() => tabA.result.current.set({ magnet: false }));
    expect(tabA.result.current.magnet).toBe(false);
    expect(tabB.result.current.magnet).toBe(false);
    act(() => tabB.result.current.set({ snap: false }));
    expect(tabA.result.current).toMatchObject({ magnet: false, snap: false, linkage: true });
  });

  it('shows a change made in one Timeline tab when a hidden tab is shown again (D3)', () => {
    const seen: Record<'a' | 'b', ReturnType<typeof useTimelineEditPrefs> | null> = { a: null, b: null };
    /**
     * One Timeline tab's switches.
     * @param props - The tab.
     * @param props.name - Which tab.
     * @returns Its magnet state as text.
     * @throws {never} Never.
     */
    function Tab({ name }: { name: 'a' | 'b' }): React.JSX.Element {
      const prefs = useTimelineEditPrefs();
      seen[name] = prefs;
      return <span data-testid={`magnet-${name}`}>{String(prefs.magnet)}</span>;
    }
    /**
     * Two tabs inside Activity boundaries, as the Project page keeps Space tabs.
     * @param props - Which tab is shown.
     * @param props.shown - The visible tab.
     * @returns Both tabs.
     * @throws {never} Never.
     */
    function Tabs({ shown }: { shown: 'a' | 'b' }): React.JSX.Element {
      return <>
        <React.Activity mode={shown === 'a' ? 'visible' : 'hidden'}><Tab name='a' /></React.Activity>
        <React.Activity mode={shown === 'b' ? 'visible' : 'hidden'}><Tab name='b' /></React.Activity>
      </>;
    }
    const view = render(<Tabs shown='b' />);
    view.rerender(<Tabs shown='a' />);
    act(() => seen.a?.set({ magnet: false }));
    expect(seen.a?.magnet).toBe(false);
    view.rerender(<Tabs shown='b' />);
    expect(seen.b?.magnet).toBe(false);
    expect(view.getByTestId('magnet-b')).toHaveTextContent('false');
  });

  it('keeps the value in memory when storage refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    const { result } = renderHook(() => useTimelineEditPrefs());
    act(() => result.current.set({ magnet: false }));
    expect(result.current.magnet).toBe(false);
  });
});
