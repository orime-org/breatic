// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { useFollowRouting, type FollowRoutingInput } from '@web/pages/project/use-follow-routing';
import { useFollowStore } from '@web/stores/follow';

const SPACES: ProjectSpace[] = [
  { id: 's1', name: 'One', type: 'canvas' },
  { id: 's2', name: 'Two', type: 'document' },
  { id: 's3', name: 'Three', type: 'canvas' },
];

/**
 * Inputs for one render; tests override what the step changes.
 * @param over - The fields this step sets.
 * @returns The input.
 */
function input(over: Partial<FollowRoutingInput>): FollowRoutingInput {
  return {
    following: true,
    leaderSpaceId: 's1',
    spaces: SPACES,
    activeId: 's1',
    ready: true,
    persist: true,
    byFollow: false,
    open: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  useFollowStore.getState().reset();
  useFollowStore.getState().start('leader', 'Leader');
});

describe('useFollowRouting', () => {
  it('opens the leader Space when following starts somewhere else', () => {
    const open = vi.fn();
    renderHook((p: FollowRoutingInput) => useFollowRouting(p), { initialProps: input({ activeId: 's2', open }) });
    expect(open).toHaveBeenCalledWith('s1');
  });

  it('opens the Space the leader switches to, and stays following after its own switch', () => {
    const open = vi.fn();
    const { rerender } = renderHook((p: FollowRoutingInput) => useFollowRouting(p), { initialProps: input({ open }) });
    rerender(input({ open, leaderSpaceId: 's3' }));
    expect(open).toHaveBeenLastCalledWith('s3');
    rerender(input({ open, leaderSpaceId: 's3', activeId: 's3', persist: true, byFollow: true }));
    expect(useFollowStore.getState().targetUserId).toBe('leader');
    expect(useFollowStore.getState().stopped).toBeNull();
  });

  it('follows the leader back to the Space in front here while its own switch away has not rendered yet', () => {
    const open = vi.fn();
    const { rerender } = renderHook((p: FollowRoutingInput) => useFollowRouting(p), { initialProps: input({ open }) });
    // The leader goes s1 -> s3 -> s1 before this tab strip has rendered the open of s3.
    rerender(input({ open, leaderSpaceId: 's3' }));
    expect(open).toHaveBeenLastCalledWith('s3');
    rerender(input({ open, leaderSpaceId: 's1' }));
    expect(open).toHaveBeenLastCalledWith('s1');
  });

  it('keeps following while the opens it asked for land one after the other', () => {
    const open = vi.fn();
    const { rerender } = renderHook((p: FollowRoutingInput) => useFollowRouting(p), { initialProps: input({ open }) });
    rerender(input({ open, leaderSpaceId: 's3' }));
    rerender(input({ open, leaderSpaceId: 's1' }));
    // Neither landing is the user's own switch.
    rerender(input({ open, leaderSpaceId: 's1', activeId: 's3', persist: true, byFollow: true }));
    rerender(input({ open, leaderSpaceId: 's1', activeId: 's1', persist: true, byFollow: true }));
    expect(useFollowStore.getState().targetUserId).toBe('leader');
    expect(useFollowStore.getState().stopped).toBeNull();
    expect(open).toHaveBeenLastCalledWith('s1');
  });

  it('stops on the user\'s own switch after the opens it asked for landed in one render', () => {
    const open = vi.fn();
    const { rerender } = renderHook((p: FollowRoutingInput) => useFollowRouting(p), { initialProps: input({ open }) });
    // The leader goes s1 -> s3 -> s1 and both opens land in one render: the tab never leaves s1.
    rerender(input({ open, leaderSpaceId: 's3' }));
    rerender(input({ open, leaderSpaceId: 's1' }));
    expect(open.mock.calls.map((c) => c[0])).toEqual(['s3', 's1']);
    rerender(input({ open, leaderSpaceId: 's1', activeId: 's1', byFollow: true }));
    // The user then clicks the s3 tab the follow left on the strip.
    rerender(input({ open, leaderSpaceId: 's1', activeId: 's3', persist: true, byFollow: false }));
    expect(useFollowStore.getState().stopped?.reason).toBe('space');
  });

  it('stays put when the leader closes every tab or names a Space that is gone', () => {
    const open = vi.fn();
    const { rerender } = renderHook((p: FollowRoutingInput) => useFollowRouting(p), { initialProps: input({ open }) });
    rerender(input({ open, leaderSpaceId: null }));
    rerender(input({ open, leaderSpaceId: 'gone' }));
    expect(open).not.toHaveBeenCalled();
    expect(useFollowStore.getState().targetUserId).toBe('leader');
  });

  it('stops when the user switches tab themselves', () => {
    const { rerender } = renderHook((p: FollowRoutingInput) => useFollowRouting(p), { initialProps: input({}) });
    rerender(input({ activeId: 's2', persist: true }));
    expect(useFollowStore.getState().targetUserId).toBeNull();
    expect(useFollowStore.getState().stopped?.reason).toBe('space');
  });

  it('stops when the user closes the tab in front or opens another Space by any route', () => {
    const { rerender } = renderHook((p: FollowRoutingInput) => useFollowRouting(p), { initialProps: input({}) });
    rerender(input({ activeId: null, persist: true }));
    expect(useFollowStore.getState().stopped?.reason).toBe('space');
  });

  it('keeps following when the tab moves because the Space in front was deleted', () => {
    const open = vi.fn();
    const { rerender } = renderHook((p: FollowRoutingInput) => useFollowRouting(p), { initialProps: input({ open }) });
    rerender(input({ open, spaces: SPACES.filter((s) => s.id !== 's1'), activeId: 's2', persist: false }));
    expect(useFollowStore.getState().targetUserId).toBe('leader');
    expect(useFollowStore.getState().stopped).toBeNull();
    rerender(input({ open, spaces: SPACES.filter((s) => s.id !== 's1'), activeId: 's2', persist: false, leaderSpaceId: 's3' }));
    expect(open).toHaveBeenLastCalledWith('s3');
  });

  it('does not stop on the first landing of the tab strip', () => {
    const { rerender } = renderHook((p: FollowRoutingInput) => useFollowRouting(p), {
      initialProps: input({ ready: false, activeId: null }),
    });
    rerender(input({ ready: true, activeId: 's2', persist: true }));
    expect(useFollowStore.getState().stopped).toBeNull();
  });

  it('does nothing while not following', () => {
    useFollowStore.getState().reset();
    const open = vi.fn();
    const { rerender } = renderHook((p: FollowRoutingInput) => useFollowRouting(p), {
      initialProps: input({ following: false, activeId: 's2', open }),
    });
    rerender(input({ following: false, leaderSpaceId: 's3', activeId: 's2', open }));
    expect(open).not.toHaveBeenCalled();
  });
});
