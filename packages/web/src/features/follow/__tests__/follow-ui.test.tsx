// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@breatic/shared';

import type { ProjectUser } from '@web/data/yjs/project-meta';
import { FOLLOW_BAR_HEIGHT, FollowBar } from '@web/features/follow/FollowBar';
import { useFollowExitToast } from '@web/features/follow/use-follow-exit-toast';
import { useFollowLeaderPresence, type FollowLeaderPresenceInput } from '@web/features/follow/use-follow-leader-presence';
import { useFollowStore } from '@web/stores/follow';

const toastMock = vi.hoisted(() => ({ info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast: toastMock }));

beforeEach(() => {
  useFollowStore.getState().reset();
  for (const fn of Object.values(toastMock)) fn.mockClear();
});

describe('FollowBar', () => {
  it('renders nothing while not following', () => {
    render(<FollowBar leaderColor='var(--color-palette-blue)' />);
    expect(screen.queryByTestId('follow-bar')).toBeNull();
    expect(screen.queryByTestId('follow-outline')).toBeNull();
  });

  it('shows whom the user follows in the leader colour, with the outline', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    render(<FollowBar leaderColor='var(--color-palette-blue)' />);
    expect(screen.getByTestId('follow-bar')).toHaveTextContent('Li Lei');
    expect(screen.getByTestId('follow-bar').style.background).toContain('--color-palette-blue');
    expect(screen.getByTestId('follow-outline')).toBeInTheDocument();
  });

  it('exports the bar height the Spaces keep clear while following', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    render(<FollowBar leaderColor='var(--color-palette-blue)' />);
    expect(FOLLOW_BAR_HEIGHT).toBe(32);
    // h-8 is 32px; the Spaces align below it, so the two must not drift apart.
    expect(screen.getByTestId('follow-bar')).toHaveClass('h-8');
  });

  it('stops following when its stop button is pressed', async () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    const user = userEvent.setup();
    render(<FollowBar leaderColor='var(--color-palette-blue)' />);
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
  /**
   * A presence record.
   * @param id - The user.
   * @param online - Whether online.
   * @returns The record.
   */
  function user(id: string, online: boolean): ProjectUser {
    return { id, online, lastSeenAt: 0 } as ProjectUser;
  }

  /** The roster by user id: the leader, this user and a third member. */
  const NAMES: ReadonlyMap<string, string> = new Map([['u1', 'Li Lei'], ['me', 'Me'], ['u2', 'Wang Fang']]);

  /**
   * Inputs for one render, with the leader online and following nobody.
   * @param over - What the case sets.
   * @returns The input.
   */
  function presence(over: Partial<FollowLeaderPresenceInput>): FollowLeaderPresenceInput {
    return { users: [user('u1', true)], memberNames: NAMES, synced: true, currentUserId: 'me', leaderFollowing: null, ...over };
  }

  it('stops with offline when the leader goes offline', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    const { rerender } = renderHook(
      (p: { users: ProjectUser[] }) => useFollowLeaderPresence(presence({ users: p.users })),
      { initialProps: { users: [user('u1', true)] } },
    );
    expect(useFollowStore.getState().targetUserId).toBe('u1');
    rerender({ users: [user('u1', false)] });
    expect(useFollowStore.getState().stopped?.reason).toBe('offline');
  });

  it('stops with offline when the leader is no longer a member', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    renderHook(() => useFollowLeaderPresence(presence({ memberNames: new Map([['me', 'Me']]) })));
    expect(useFollowStore.getState().stopped?.reason).toBe('offline');
  });

  it('judges nothing before the presence records have synced', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    renderHook(() => useFollowLeaderPresence(presence({ users: [], memberNames: new Map(), synced: false, leaderFollowing: 'u2' })));
    expect(useFollowStore.getState().targetUserId).toBe('u1');
  });

  it('stops when the leader starts following another member, naming them', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    const { rerender } = renderHook(
      (p: { leaderFollowing: string | null }) => useFollowLeaderPresence(presence(p)),
      { initialProps: { leaderFollowing: null as string | null } },
    );
    expect(useFollowStore.getState().targetUserId).toBe('u1');
    rerender({ leaderFollowing: 'u2' });
    expect(useFollowStore.getState().stopped).toMatchObject({ reason: 'leaderFollows', userId: 'u1', other: { name: 'Wang Fang' } });
  });

  it('stops when the leader starts following this user', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    renderHook(() => useFollowLeaderPresence(presence({ leaderFollowing: 'me' })));
    expect(useFollowStore.getState().stopped).toMatchObject({ reason: 'leaderFollows', other: 'you' });
  });

  it('keeps following while the member the leader follows is not on the roster', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    renderHook(() => useFollowLeaderPresence(presence({ leaderFollowing: 'u-gone' })));
    expect(useFollowStore.getState().targetUserId).toBe('u1');
    expect(useFollowStore.getState().stopped).toBeNull();
  });
});
