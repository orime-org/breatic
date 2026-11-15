// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { beforeEach, describe, expect, it } from 'vitest';

import { useFollowStore } from '@web/stores/follow';
import { resetProjectUiStores } from '@web/stores/reset-project-ui';

beforeEach(() => {
  useFollowStore.getState().reset();
});

describe('useFollowStore', () => {
  it('starts following one member', () => {
    useFollowStore.getState().start('u1');
    expect(useFollowStore.getState().targetUserId).toBe('u1');
    expect(useFollowStore.getState().stopped).toBeNull();
  });

  it('switches to another member without recording a stop', () => {
    useFollowStore.getState().start('u1');
    useFollowStore.getState().start('u2');
    expect(useFollowStore.getState().targetUserId).toBe('u2');
    expect(useFollowStore.getState().stopped).toBeNull();
  });

  it('records why and whom following stopped, once per stop', () => {
    useFollowStore.getState().start('u1');
    useFollowStore.getState().stop('viewport');
    const first = useFollowStore.getState().stopped;
    expect(useFollowStore.getState().targetUserId).toBeNull();
    expect(first).toMatchObject({ reason: 'viewport', userId: 'u1' });
    useFollowStore.getState().start('u1');
    useFollowStore.getState().stop('viewport');
    expect(useFollowStore.getState().stopped?.seq).not.toBe(first?.seq);
  });

  it('records each of the four reasons', () => {
    for (const reason of ['button', 'viewport', 'space', 'offline'] as const) {
      useFollowStore.getState().start('u1');
      useFollowStore.getState().stop(reason);
      expect(useFollowStore.getState().stopped?.reason).toBe(reason);
    }
  });

  it('does nothing when asked to stop while not following', () => {
    useFollowStore.getState().stop('viewport');
    expect(useFollowStore.getState().stopped).toBeNull();
  });

  it('resets silently', () => {
    useFollowStore.getState().start('u1');
    useFollowStore.getState().reset();
    expect(useFollowStore.getState()).toMatchObject({ targetUserId: null, stopped: null });
  });

  it('is cleared, without a stop, when the user leaves the project', () => {
    useFollowStore.getState().start('u1');
    resetProjectUiStores('p1');
    expect(useFollowStore.getState()).toMatchObject({ targetUserId: null, stopped: null });
  });
});
