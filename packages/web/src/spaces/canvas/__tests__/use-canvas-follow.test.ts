// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { followViewport } from '@web/features/follow/follow-geometry';
import { useCanvasFollow, type CanvasFollowInput } from '@web/spaces/canvas/use-canvas-follow';
import { useFollowStore } from '@web/stores/follow';

const docs: Y.Doc[] = [];
const PANE = { width: 1000, height: 500 };

/**
 * An awareness over a throwaway document.
 * @returns The awareness.
 */
function makeAwareness(): Awareness {
  const doc = new Y.Doc();
  docs.push(doc);
  return new Awareness(doc);
}

/**
 * Make a peer's state arrive on the local awareness, the way the provider does.
 * @param local - This client's awareness.
 * @param peer - The peer's awareness.
 * @param state - The state the peer publishes.
 */
function arrive(local: Awareness, peer: Awareness, state: Record<string, unknown>): void {
  peer.setLocalState(state);
  act(() => {
    applyAwarenessUpdate(local, encodeAwarenessUpdate(peer, [peer.clientID]), 'remote');
  });
}

/**
 * Inputs for one render.
 * @param over - What the case sets.
 * @returns The input.
 */
function input(over: Partial<CanvasFollowInput> & Pick<CanvasFollowInput, 'awareness'>): CanvasFollowInput {
  return {
    leaderUserId: 'leader',
    ready: true,
    paneSize: () => PANE,
    applyViewport: vi.fn(),
    clearOpeningFit: vi.fn(),
    ...over,
  };
}

const RECT = { x: 100, y: 50, width: 400, height: 300 };

beforeEach(() => {
  useFollowStore.getState().reset();
  useFollowStore.getState().start('leader');
});

afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

describe('useCanvasFollow', () => {
  it('fits the leader rectangle into this pane, clearing the opening fit first', () => {
    const local = makeAwareness();
    const peer = makeAwareness();
    const calls: string[] = [];
    const applyViewport = vi.fn(() => calls.push('apply'));
    const clearOpeningFit = vi.fn(() => calls.push('clear'));
    renderHook(() => useCanvasFollow(input({ awareness: local, applyViewport, clearOpeningFit })));
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...RECT, at: 1 } });
    expect(applyViewport).toHaveBeenLastCalledWith(followViewport(RECT, PANE));
    expect(calls.slice(0, 2)).toEqual(['clear', 'apply']);
  });

  it('follows each new leader rectangle and clears the opening fit only once', () => {
    const local = makeAwareness();
    const peer = makeAwareness();
    const applyViewport = vi.fn();
    const clearOpeningFit = vi.fn();
    renderHook(() => useCanvasFollow(input({ awareness: local, applyViewport, clearOpeningFit })));
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...RECT, at: 1 } });
    const next = { x: 900, y: 50, width: 400, height: 300 };
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...next, at: 2 } });
    expect(applyViewport).toHaveBeenLastCalledWith(followViewport(next, PANE));
    expect(clearOpeningFit).toHaveBeenCalledTimes(1);
  });

  it('waits until the canvas is ready, then aligns to the leader rectangle already there', () => {
    const local = makeAwareness();
    const peer = makeAwareness();
    const applyViewport = vi.fn();
    const { rerender } = renderHook((p: CanvasFollowInput) => useCanvasFollow(p), {
      initialProps: input({ awareness: local, applyViewport, ready: false }),
    });
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...RECT, at: 1 } });
    expect(applyViewport).not.toHaveBeenCalled();
    rerender(input({ awareness: local, applyViewport, ready: true }));
    expect(applyViewport).toHaveBeenCalledWith(followViewport(RECT, PANE));
  });

  it('ignores other members and does nothing while not following', () => {
    const local = makeAwareness();
    const peer = makeAwareness();
    const applyViewport = vi.fn();
    const { rerender } = renderHook((p: CanvasFollowInput) => useCanvasFollow(p), {
      initialProps: input({ awareness: local, applyViewport }),
    });
    arrive(local, peer, { user: { id: 'someone-else' }, camera: { ...RECT, at: 1 } });
    expect(applyViewport).not.toHaveBeenCalled();
    rerender(input({ awareness: local, applyViewport, leaderUserId: null }));
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...RECT, at: 2 } });
    expect(applyViewport).not.toHaveBeenCalled();
  });

  it('does not stop on the move its own alignment starts', () => {
    const local = makeAwareness();
    const peer = makeAwareness();
    let onMoveStart: ((event: unknown) => void) | null = null;
    const applyViewport = vi.fn(() => onMoveStart?.(null));
    const { result } = renderHook(() => useCanvasFollow(input({ awareness: local, applyViewport })));
    onMoveStart = result.current.onMoveStart;
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...RECT, at: 1 } });
    expect(applyViewport).toHaveBeenCalled();
    expect(useFollowStore.getState().targetUserId).toBe('leader');
  });

  it('stops on any other move start, with or without an input event, and then stops aligning', () => {
    const local = makeAwareness();
    const peer = makeAwareness();
    const applyViewport = vi.fn();
    const { result } = renderHook(() => useCanvasFollow(input({ awareness: local, applyViewport })));
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...RECT, at: 1 } });
    act(() => result.current.onMoveStart(null));
    expect(useFollowStore.getState().stopped?.reason).toBe('viewport');
    applyViewport.mockClear();
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...RECT, x: 0, at: 2 } });
    expect(applyViewport).not.toHaveBeenCalled();
  });

  it('hands back the leader rectangle to republish once it has aligned', () => {
    const local = makeAwareness();
    const peer = makeAwareness();
    const { result } = renderHook(() => useCanvasFollow(input({ awareness: local })));
    expect(result.current.followCamera).toBeNull();
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...RECT, at: 1 } });
    expect(result.current.followCamera).toEqual(RECT);
  });
});
