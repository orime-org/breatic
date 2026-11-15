// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectUser } from '@web/data/yjs/project-meta';
import { FollowBar } from '@web/features/follow/FollowBar';
import { useFollowExitToast } from '@web/features/follow/use-follow-exit-toast';
import { useFollowLeaderPresence } from '@web/features/follow/use-follow-leader-presence';
import { useFollowStore } from '@web/stores/follow';

const toastMock = vi.hoisted(() => ({ info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast: toastMock }));

beforeEach(() => {
  useFollowStore.getState().reset();
  for (const fn of Object.values(toastMock)) fn.mockClear();
});

describe('FollowBar', () => {
  it('renders nothing while not following', () => {
    render(<FollowBar leaderName='Li Lei' leaderColor='var(--color-palette-blue)' />);
    expect(screen.queryByTestId('follow-bar')).toBeNull();
    expect(screen.queryByTestId('follow-outline')).toBeNull();
  });

  it('shows whom the user follows in the leader colour, with the outline', () => {
    useFollowStore.getState().start('u1');
    render(<FollowBar leaderName='Li Lei' leaderColor='var(--color-palette-blue)' />);
    expect(screen.getByTestId('follow-bar')).toHaveTextContent('Li Lei');
    expect(screen.getByTestId('follow-bar').style.background).toContain('--color-palette-blue');
    expect(screen.getByTestId('follow-outline')).toBeInTheDocument();
  });

  it('stops following when its stop button is pressed', async () => {
    useFollowStore.getState().start('u1');
    const user = userEvent.setup();
    render(<FollowBar leaderName='Li Lei' leaderColor='var(--color-palette-blue)' />);
    await user.click(screen.getByTestId('follow-bar-stop'));
    expect(useFollowStore.getState().targetUserId).toBeNull();
    expect(useFollowStore.getState().stopped?.reason).toBe('button');
    expect(screen.queryByTestId('follow-bar')).toBeNull();
    expect(screen.queryByTestId('follow-outline')).toBeNull();
  });
});

describe('useFollowExitToast', () => {
  const nameOf = (userId: string): string => (userId === 'u1' ? 'Li Lei' : 'someone');

  it('says nothing when the user pressed stop', () => {
    renderHook(() => useFollowExitToast(nameOf));
    act(() => {
      useFollowStore.getState().start('u1');
      useFollowStore.getState().stop('button');
    });
    expect(toastMock.info).not.toHaveBeenCalled();
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it('tells the user they moved the view or switched Space themselves', () => {
    renderHook(() => useFollowExitToast(nameOf));
    act(() => {
      useFollowStore.getState().start('u1');
      useFollowStore.getState().stop('viewport');
    });
    act(() => {
      useFollowStore.getState().start('u1');
      useFollowStore.getState().stop('space');
    });
    expect(toastMock.info).toHaveBeenCalledTimes(2);
    expect(toastMock.info.mock.calls[0]?.[0]).not.toBe(toastMock.info.mock.calls[1]?.[0]);
  });

  it('warns with the leader name when the leader went offline', () => {
    renderHook(() => useFollowExitToast(nameOf));
    act(() => {
      useFollowStore.getState().start('u1');
      useFollowStore.getState().stop('offline');
    });
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    expect(String(toastMock.warning.mock.calls[0]?.[0])).toContain('Li Lei');
  });

  it('says nothing for a reset on leaving the project', () => {
    renderHook(() => useFollowExitToast(nameOf));
    act(() => {
      useFollowStore.getState().start('u1');
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

  it('stops with offline when the leader goes offline', () => {
    useFollowStore.getState().start('u1');
    const { rerender } = renderHook(
      (p: { users: ProjectUser[] }) => useFollowLeaderPresence({ users: p.users, memberUserIds: ['u1', 'me'], synced: true }),
      { initialProps: { users: [user('u1', true)] } },
    );
    expect(useFollowStore.getState().targetUserId).toBe('u1');
    rerender({ users: [user('u1', false)] });
    expect(useFollowStore.getState().stopped?.reason).toBe('offline');
  });

  it('stops with offline when the leader is no longer a member', () => {
    useFollowStore.getState().start('u1');
    renderHook(() => useFollowLeaderPresence({ users: [user('u1', true)], memberUserIds: ['me'], synced: true }));
    expect(useFollowStore.getState().stopped?.reason).toBe('offline');
  });

  it('judges nothing before the presence records have synced', () => {
    useFollowStore.getState().start('u1');
    renderHook(() => useFollowLeaderPresence({ users: [], memberUserIds: [], synced: false }));
    expect(useFollowStore.getState().targetUserId).toBe('u1');
  });
});
