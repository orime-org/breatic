// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from 'vitest';

import { useFollowStore } from '@web/stores/follow';
import { resetProjectUiStores } from '@web/stores/reset-project-ui';

beforeEach(() => {
  useFollowStore.getState().reset();
});

describe('useFollowStore', () => {
  it('starts following one member', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    expect(useFollowStore.getState().targetUserId).toBe('u1');
    expect(useFollowStore.getState().stopped).toBeNull();
  });

  it('switches to another member without recording a stop', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    useFollowStore.getState().start('u2', 'Han Meimei');
    expect(useFollowStore.getState().targetUserId).toBe('u2');
    expect(useFollowStore.getState().stopped).toBeNull();
  });

  it('records why and whom following stopped, once per stop', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    useFollowStore.getState().stop('viewport');
    const first = useFollowStore.getState().stopped;
    expect(useFollowStore.getState().targetUserId).toBeNull();
    expect(first).toMatchObject({ reason: 'viewport', userId: 'u1' });
    useFollowStore.getState().start('u1', 'Li Lei');
    useFollowStore.getState().stop('viewport');
    expect(useFollowStore.getState().stopped?.seq).not.toBe(first?.seq);
  });

  it('records each of the five reasons', () => {
    for (const reason of ['button', 'viewport', 'space', 'offline', 'leaderFollows'] as const) {
      useFollowStore.getState().start('u1', 'Li Lei');
      if (reason === 'leaderFollows') useFollowStore.getState().stop(reason, 'you');
      else useFollowStore.getState().stop(reason);
      expect(useFollowStore.getState().stopped?.reason).toBe(reason);
    }
  });

  it('keeps the followed member name and hands it to the stop, so the notice names a leader who left the roster', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    expect(useFollowStore.getState().targetName).toBe('Li Lei');
    useFollowStore.getState().start('u2', 'Han Meimei');
    expect(useFollowStore.getState().targetName).toBe('Han Meimei');
    useFollowStore.getState().stop('offline');
    expect(useFollowStore.getState().stopped).toMatchObject({ reason: 'offline', userId: 'u2', name: 'Han Meimei' });
    expect(useFollowStore.getState().targetName).toBeNull();
  });

  it('records whom the leader started following, a member by name or this user', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    useFollowStore.getState().stop('leaderFollows', { name: 'Wang Fang' });
    expect(useFollowStore.getState().stopped).toMatchObject({ reason: 'leaderFollows', name: 'Li Lei', other: { name: 'Wang Fang' } });
    useFollowStore.getState().start('u1', 'Li Lei');
    useFollowStore.getState().stop('leaderFollows', 'you');
    expect(useFollowStore.getState().stopped).toMatchObject({ reason: 'leaderFollows', other: 'you' });
    useFollowStore.getState().start('u1', 'Li Lei');
    useFollowStore.getState().stop('viewport');
    expect(useFollowStore.getState().stopped?.other).toBeNull();
  });

  it('does nothing when asked to stop while not following', () => {
    useFollowStore.getState().stop('viewport');
    expect(useFollowStore.getState().stopped).toBeNull();
  });

  it('resets silently', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    useFollowStore.getState().reset();
    expect(useFollowStore.getState()).toMatchObject({ targetUserId: null, targetName: null, stopped: null });
  });

  it('is cleared, without a stop, when the user leaves the project', () => {
    useFollowStore.getState().start('u1', 'Li Lei');
    resetProjectUiStores('p1');
    expect(useFollowStore.getState()).toMatchObject({ targetUserId: null, stopped: null });
  });
});
