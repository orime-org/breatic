// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { act, renderHook } from '@testing-library/react';
import type { Viewport } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { FOLLOW_BAR_HEIGHT } from '@web/features/follow/FollowBar';
import { followViewport, type FlowRect, type PaneSize } from '@web/features/follow/follow-geometry';
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
    pane: PANE,
    applyViewport: vi.fn(),
    clearOpeningFit: vi.fn(),
    openingFitHeld: false,
    frameCanvas: vi.fn(),
    ...over,
  };
}

/**
 * The viewport that shows a leader rectangle below the follow bar: fitted into
 * the pane minus the bar, then moved down by the bar (finding C).
 * @param rect - The leader rectangle.
 * @param pane - This client's pane.
 * @returns The viewport the hook should set.
 */
function followFit(rect: FlowRect, pane: PaneSize): Viewport {
  const fit = followViewport(rect, { width: pane.width, height: pane.height - FOLLOW_BAR_HEIGHT });
  return { ...fit, y: fit.y + FOLLOW_BAR_HEIGHT };
}

const RECT = { x: 100, y: 50, width: 400, height: 300 };

beforeEach(() => {
  useFollowStore.getState().reset();
  useFollowStore.getState().start('leader', 'Leader');
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
    expect(applyViewport).toHaveBeenLastCalledWith(followFit(RECT, PANE));
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
    expect(applyViewport).toHaveBeenLastCalledWith(followFit(next, PANE));
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
    expect(applyViewport).toHaveBeenCalledWith(followFit(RECT, PANE));
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
    onMoveStart = result.current;
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...RECT, at: 1 } });
    expect(applyViewport).toHaveBeenCalled();
    expect(useFollowStore.getState().targetUserId).toBe('leader');
  });

  it('does not stop on the moves its later alignments start either', () => {
    const local = makeAwareness();
    const peer = makeAwareness();
    let onMoveStart: ((event: unknown) => void) | null = null;
    const applyViewport = vi.fn(() => onMoveStart?.(null));
    const { result } = renderHook(() => useCanvasFollow(input({ awareness: local, applyViewport })));
    onMoveStart = result.current;
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...RECT, at: 1 } });
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...RECT, x: 700, at: 2 } });
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...RECT, x: 900, at: 3 } });
    expect(applyViewport).toHaveBeenCalledTimes(3);
    expect(useFollowStore.getState().targetUserId).toBe('leader');
  });

  it('stops on any other move start, with or without an input event, and then stops aligning', () => {
    const local = makeAwareness();
    const peer = makeAwareness();
    const applyViewport = vi.fn();
    const { result } = renderHook(() => useCanvasFollow(input({ awareness: local, applyViewport })));
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...RECT, at: 1 } });
    act(() => result.current(null));
    expect(useFollowStore.getState().stopped?.reason).toBe('viewport');
    applyViewport.mockClear();
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...RECT, x: 0, at: 2 } });
    expect(applyViewport).not.toHaveBeenCalled();
  });

  it('shows the whole leader rectangle below the follow bar', () => {
    const local = makeAwareness();
    const peer = makeAwareness();
    const applyViewport = vi.fn();
    renderHook(() => useCanvasFollow(input({ awareness: local, applyViewport })));
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...RECT, at: 1 } });
    const v = applyViewport.mock.lastCall?.[0] as Viewport;
    // The rectangle's top and bottom edges on screen, in pane pixels.
    const top = RECT.y * v.zoom + v.y;
    const bottom = (RECT.y + RECT.height) * v.zoom + v.y;
    expect(top).toBeGreaterThanOrEqual(FOLLOW_BAR_HEIGHT - 0.001);
    expect(bottom).toBeLessThanOrEqual(PANE.height + 0.001);
  });

  it('fits the leader rectangle again when this pane changes size, without stopping', () => {
    const local = makeAwareness();
    const peer = makeAwareness();
    let onMoveStart: ((event: unknown) => void) | null = null;
    const applyViewport = vi.fn(() => onMoveStart?.(null));
    const { result, rerender } = renderHook((p: CanvasFollowInput) => useCanvasFollow(p), {
      initialProps: input({ awareness: local, applyViewport }),
    });
    onMoveStart = result.current;
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...RECT, at: 1 } });
    const wider = { width: 1400, height: 700 };
    rerender(input({ awareness: local, applyViewport, pane: wider }));
    expect(applyViewport).toHaveBeenCalledTimes(2);
    expect(applyViewport).toHaveBeenLastCalledWith(followFit(RECT, wider));
    expect(useFollowStore.getState().targetUserId).toBe('leader');
  });

  it('stops on a move the user starts before the first alignment', () => {
    const local = makeAwareness();
    const { result } = renderHook(() => useCanvasFollow(input({ awareness: local })));
    act(() => result.current(new MouseEvent('wheel')));
    expect(useFollowStore.getState().stopped?.reason).toBe('viewport');
  });

  it('drops the queued opening fit as soon as following starts, before the leader shows a camera', () => {
    const local = makeAwareness();
    const clearOpeningFit = vi.fn();
    renderHook(() => useCanvasFollow(input({ awareness: local, clearOpeningFit })));
    expect(clearOpeningFit).toHaveBeenCalledTimes(1);
  });

  it('frames a canvas that opened while following once following ends, when no alignment ever placed it', () => {
    const local = makeAwareness();
    const frameCanvas = vi.fn();
    const { rerender } = renderHook((p: CanvasFollowInput) => useCanvasFollow(p), {
      initialProps: input({ awareness: local, openingFitHeld: true, frameCanvas }),
    });
    expect(frameCanvas).not.toHaveBeenCalled();
    rerender(input({ awareness: local, openingFitHeld: true, frameCanvas, leaderUserId: null }));
    expect(frameCanvas).toHaveBeenCalledTimes(1);
  });

  it('leaves a canvas the follow placed where it is once following ends', () => {
    const local = makeAwareness();
    const peer = makeAwareness();
    const frameCanvas = vi.fn();
    const { rerender } = renderHook((p: CanvasFollowInput) => useCanvasFollow(p), {
      initialProps: input({ awareness: local, openingFitHeld: true, frameCanvas }),
    });
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...RECT, at: 1 } });
    rerender(input({ awareness: local, openingFitHeld: true, frameCanvas, leaderUserId: null }));
    expect(frameCanvas).not.toHaveBeenCalled();
  });

  it('frames nothing when following ends on a canvas that kept its own opening fit', () => {
    const local = makeAwareness();
    const frameCanvas = vi.fn();
    const { rerender } = renderHook((p: CanvasFollowInput) => useCanvasFollow(p), {
      initialProps: input({ awareness: local, frameCanvas }),
    });
    rerender(input({ awareness: local, frameCanvas, leaderUserId: null }));
    expect(frameCanvas).not.toHaveBeenCalled();
  });

  it('stops on a toolbar, minimap or shortcut move before the first alignment', () => {
    // The leader has no camera on this canvas (no Space open, or not published yet), so nothing aligns.
    const local = makeAwareness();
    const { result } = renderHook(() => useCanvasFollow(input({ awareness: local })));
    act(() => result.current(null));
    expect(useFollowStore.getState().stopped?.reason).toBe('viewport');
  });

});
