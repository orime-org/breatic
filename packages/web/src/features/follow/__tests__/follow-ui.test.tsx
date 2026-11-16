// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@breatic/shared';

import { FOLLOW_BAR_HEIGHT, FollowBar } from '@web/features/follow/FollowBar';
import { useFollowExitToast } from '@web/features/follow/use-follow-exit-toast';
import { useFollowLeaderPresence, type FollowLeaderPresenceInput } from '@web/features/follow/use-follow-leader-presence';
import { useFollowStore, type FollowOther } from '@web/stores/follow';
import { userPaletteColor } from '@web/lib/user-color';

const toastMock = vi.hoisted(() => ({ info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast: toastMock }));

beforeEach(() => {
  useFollowStore.getState().reset();
  for (const fn of Object.values(toastMock)) fn.mockClear();
});

describe('FollowBar', () => {
  it('renders nothing while not following', () => {
    render(<FollowBar spaceType='canvas' />);
    expect(screen.queryByTestId('follow-bar')).toBeNull();
    expect(screen.queryByTestId('follow-outline')).toBeNull();
  });

  it('shows whom the user follows in the leader colour, with the outline', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    render(<FollowBar spaceType='canvas' />);
    expect(screen.getByTestId('follow-bar')).toHaveTextContent('Li Lei');
    // The bar takes the leader's collaborator colour itself, from whom the store follows.
    expect(screen.getByTestId('follow-bar').style.background).toBe(userPaletteColor('u1'));
    expect(screen.getByTestId('follow-outline')).toBeInTheDocument();
  });

  it('draws the label as heavy as other names on a collaborator colour, and Stop on a deeper chip', () => {
    // The chip leans toward the theme foreground, away from the on-palette
    // text, so Stop reads at least as clearly as the label in both themes.
    useFollowStore.getState().start('u1', 'Li Lei');
    render(<FollowBar spaceType='canvas' />);
    expect(screen.getByText(t('members.follow.bar', { name: 'Li Lei' }))).toHaveClass('font-semibold');
    const stop = screen.getByTestId('follow-bar-stop');
    expect(stop.className).toContain('bg-[color-mix(in_srgb,var(--color-foreground)_20%,transparent)]');
    expect(stop.className).toContain('hover-enabled:bg-[color-mix(in_srgb,var(--color-foreground)_30%,transparent)]');
    expect(stop.className).not.toContain('var(--color-on-palette)_20%');
  });

  it('exports the bar height the Spaces keep clear while following', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    render(<FollowBar spaceType='canvas' />);
    expect(FOLLOW_BAR_HEIGHT).toBe(32);
    // h-8 is 32px; the Spaces align below it, so the two must not drift apart.
    expect(screen.getByTestId('follow-bar')).toHaveClass('h-8');
  });

  it('lies over a Space the user pans freely, and takes its own row above any other', () => {
    // Canvas and 3D move under the bar at will; a document or a timeline would
    // lose its top lines under it, so their content moves down instead.
    useFollowStore.getState().start('u1', 'Li Lei');
    for (const type of ['canvas', '3d'] as const) {
      const { unmount } = render(<FollowBar spaceType={type} />);
      expect(screen.getByTestId('follow-bar')).toHaveClass('absolute');
      unmount();
    }
    for (const type of ['document', 'timeline', null] as const) {
      const { unmount } = render(<FollowBar spaceType={type} />);
      expect(screen.getByTestId('follow-bar')).toHaveClass('shrink-0');
      expect(screen.getByTestId('follow-bar')).not.toHaveClass('absolute');
      unmount();
    }
  });

  it('stops following when its stop button is pressed', async () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    const user = userEvent.setup();
    render(<FollowBar spaceType='canvas' />);
    await user.click(screen.getByTestId('follow-bar-stop'));
    expect(useFollowStore.getState().targetUserId).toBeNull();
    expect(useFollowStore.getState().stopped?.reason).toBe('button');
    expect(screen.queryByTestId('follow-bar')).toBeNull();
    expect(screen.queryByTestId('follow-outline')).toBeNull();
  });
});

describe('useFollowExitToast', () => {
  it('says nothing when the user pressed stop', () => {
    renderHook(() => useFollowExitToast());
    act(() => {
      useFollowStore.getState().start('u1', 'Li Lei');
      useFollowStore.getState().stop('button');
    });
    expect(toastMock.info).not.toHaveBeenCalled();
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it('tells the user they moved the view or switched Space themselves', () => {
    renderHook(() => useFollowExitToast());
    act(() => {
      useFollowStore.getState().start('u1', 'Li Lei');
      useFollowStore.getState().stop('viewport');
    });
    act(() => {
      useFollowStore.getState().start('u1', 'Li Lei');
      useFollowStore.getState().stop('space');
    });
    expect(toastMock.info).toHaveBeenCalledTimes(2);
    expect(toastMock.info.mock.calls[0]?.[0]).not.toBe(toastMock.info.mock.calls[1]?.[0]);
  });

  it('warns with the leader name when the leader went offline', () => {
    renderHook(() => useFollowExitToast());
    act(() => {
      useFollowStore.getState().start('u1', 'Li Lei');
      useFollowStore.getState().stop('offline');
    });
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    expect(String(toastMock.warning.mock.calls[0]?.[0])).toContain('Li Lei');
  });

  it('names the leader from the stop itself, after the leader has left the member list', () => {
    renderHook(() => useFollowExitToast());
    act(() => {
      useFollowStore.getState().start('u-gone', 'Removed Member');
      useFollowStore.getState().stop('offline');
    });
    expect(String(toastMock.warning.mock.calls[0]?.[0])).toContain('Removed Member');
  });

  it('names the leader and whom they started following', () => {
    renderHook(() => useFollowExitToast());
    act(() => {
      useFollowStore.getState().start('u1', 'Li Lei');
      useFollowStore.getState().stop('leaderFollows', { name: 'Wang Fang' });
    });
    expect(toastMock.info).toHaveBeenCalledWith(t('members.follow.stoppedLeaderFollows', { name: 'Li Lei', other: 'Wang Fang' }));
  });

  it('says the leader started following this user', () => {
    renderHook(() => useFollowExitToast());
    act(() => {
      useFollowStore.getState().start('u1', 'Li Lei');
      useFollowStore.getState().stop('leaderFollows', 'you');
    });
    expect(toastMock.info).toHaveBeenCalledWith(t('members.follow.stoppedLeaderFollowsYou', { name: 'Li Lei' }));
  });

  it('says nothing for a reset on leaving the project', () => {
    renderHook(() => useFollowExitToast());
    act(() => {
      useFollowStore.getState().start('u1', 'Li Lei');
      useFollowStore.getState().reset();
    });
    expect(toastMock.info).not.toHaveBeenCalled();
    expect(toastMock.warning).not.toHaveBeenCalled();
  });
});

describe('useFollowLeaderPresence', () => {
  /** The roster by user id: the leader, this user and a third member. */
  const NAMES: ReadonlyMap<string, string> = new Map([['u1', 'Li Lei'], ['me', 'Me'], ['u2', 'Wang Fang']]);

  /**
   * Inputs for one render, with the leader online and following nobody.
   * @param over - What the case sets.
   * @returns The input.
   */
  function presence(over: Partial<FollowLeaderPresenceInput>): FollowLeaderPresenceInput {
    return { onlineUserIds: new Set(['u1', 'me']), memberNames: NAMES, synced: true, leaderFollows: null, ...over };
  }

  it('stops with offline when the leader goes offline', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    const { rerender } = renderHook(
      (p: { online: ReadonlySet<string> }) => useFollowLeaderPresence(presence({ onlineUserIds: p.online })),
      { initialProps: { online: new Set(['u1', 'me']) as ReadonlySet<string> } },
    );
    expect(useFollowStore.getState().targetUserId).toBe('u1');
    rerender({ online: new Set(['me']) });
    expect(useFollowStore.getState().stopped?.reason).toBe('offline');
  });

  it('stops with offline when the leader is no longer a member', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    renderHook(() => useFollowLeaderPresence(presence({ memberNames: new Map([['me', 'Me']]) })));
    expect(useFollowStore.getState().stopped?.reason).toBe('offline');
  });

  it('judges nothing before the presence records have synced', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    renderHook(() => useFollowLeaderPresence(presence({ onlineUserIds: new Set(), memberNames: new Map(), synced: false, leaderFollows: 'you' })));
    expect(useFollowStore.getState().targetUserId).toBe('u1');
  });

  it('stops when the leader starts following another member, naming them', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    const { rerender } = renderHook(
      (p: { leaderFollows: FollowOther | null }) => useFollowLeaderPresence(presence(p)),
      { initialProps: { leaderFollows: null as FollowOther | null } },
    );
    expect(useFollowStore.getState().targetUserId).toBe('u1');
    rerender({ leaderFollows: { name: 'Wang Fang' } });
    expect(useFollowStore.getState().stopped).toMatchObject({ reason: 'leaderFollows', userId: 'u1', other: { name: 'Wang Fang' } });
  });

  it('stops when the leader starts following this user', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    renderHook(() => useFollowLeaderPresence(presence({ leaderFollows: 'you' })));
    expect(useFollowStore.getState().stopped).toMatchObject({ reason: 'leaderFollows', other: 'you' });
  });
});
