// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { act, renderHook } from '@testing-library/react';
import type { Viewport } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { FOLLOW_BAR_HEIGHT } from '@web/features/follow/FollowBar';
import { followViewport, visibleRect, type FlowRect, type PaneSize } from '@web/features/follow/follow-geometry';
import { useCanvasFollow, type CanvasFollowInput } from '@web/spaces/canvas/use-canvas-follow';
import { usePublishPresence } from '@web/spaces/canvas/use-publish-presence';
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
 * Inputs for one render. `pane` is the pane size the hook re-aligns on
 * (finding A); `paneSize` is the reader it replaces and goes once the hook
 * takes `pane`.
 * @param over - What the case sets.
 * @returns The input.
 */
function input(over: Partial<CanvasFollowInput> & Pick<CanvasFollowInput, 'awareness'>): CanvasFollowInput {
  const pane: PaneSize = (over as { pane?: PaneSize }).pane ?? PANE;
  return {
    leaderUserId: 'leader',
    ready: true,
    pane,
    paneSize: () => pane,
    applyViewport: vi.fn(),
    clearOpeningFit: vi.fn(),
    ...over,
  } as CanvasFollowInput;
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
    onMoveStart = result.current.onMoveStart;
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
    onMoveStart = result.current.onMoveStart;
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
    act(() => result.current.onMoveStart(null));
    expect(useFollowStore.getState().stopped?.reason).toBe('viewport');
    applyViewport.mockClear();
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...RECT, x: 0, at: 2 } });
    expect(applyViewport).not.toHaveBeenCalled();
  });

  it('shows the whole leader rectangle below the follow bar, and still republishes the leader rectangle unchanged', () => {
    const local = makeAwareness();
    const peer = makeAwareness();
    const applyViewport = vi.fn();
    const { result } = renderHook(() => useCanvasFollow(input({ awareness: local, applyViewport })));
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...RECT, at: 1 } });
    const v = applyViewport.mock.lastCall?.[0] as Viewport;
    // The rectangle's top and bottom edges on screen, in pane pixels.
    const top = RECT.y * v.zoom + v.y;
    const bottom = (RECT.y + RECT.height) * v.zoom + v.y;
    expect(top).toBeGreaterThanOrEqual(FOLLOW_BAR_HEIGHT - 0.001);
    expect(bottom).toBeLessThanOrEqual(PANE.height + 0.001);
    expect(result.current.followCamera).toEqual(RECT);
  });

  it('fits the leader rectangle again when this pane changes size, without stopping', () => {
    const local = makeAwareness();
    const peer = makeAwareness();
    let onMoveStart: ((event: unknown) => void) | null = null;
    const applyViewport = vi.fn(() => onMoveStart?.(null));
    const { result, rerender } = renderHook((p: CanvasFollowInput) => useCanvasFollow(p), {
      initialProps: input({ awareness: local, applyViewport }),
    });
    onMoveStart = result.current.onMoveStart;
    arrive(local, peer, { user: { id: 'leader' }, camera: { ...RECT, at: 1 } });
    const wider = { width: 1400, height: 700 };
    rerender(input({ awareness: local, applyViewport, pane: wider } as Partial<CanvasFollowInput> & Pick<CanvasFollowInput, 'awareness'>));
    expect(applyViewport).toHaveBeenCalledTimes(2);
    expect(applyViewport).toHaveBeenLastCalledWith(followFit(RECT, wider));
    expect(useFollowStore.getState().targetUserId).toBe('leader');
  });

  it('stops on a move the user starts before the first alignment', () => {
    const local = makeAwareness();
    const { result } = renderHook(() => useCanvasFollow(input({ awareness: local })));
    act(() => result.current.onMoveStart(new MouseEvent('wheel')));
    expect(useFollowStore.getState().stopped?.reason).toBe('viewport');
  });

  it('lets a programmatic move before the first alignment pass, such as the opening fit', () => {
    const local = makeAwareness();
    const { result } = renderHook(() => useCanvasFollow(input({ awareness: local })));
    act(() => result.current.onMoveStart(null));
    expect(useFollowStore.getState().targetUserId).toBe('leader');
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

describe('useCanvasFollow with the camera publisher, two members following each other', () => {
  /** One browser: its awareness, pane and viewport, following through the real hooks. */
  interface Client {
    userId: string;
    awareness: Awareness;
    pane: PaneSize;
    viewport: Viewport;
    rerender: (props: { leader: string | null }) => void;
    followCamera: () => FlowRect | null;
  }

  /**
   * Mount one browser's canvas follow and camera publisher, as CanvasSpace wires them.
   * @param userId - Whose browser this is.
   * @param pane - Its pane size.
   * @param viewport - Its starting viewport.
   * @returns The client.
   */
  function mountClient(userId: string, pane: PaneSize, viewport: Viewport): Client {
    const awareness = makeAwareness();
    awareness.setLocalState({ user: { id: userId } });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const client = { userId, awareness, pane, viewport } as Client;
    const hook = renderHook(
      (p: { leader: string | null }) => {
        const follow = useCanvasFollow({
          awareness,
          leaderUserId: p.leader,
          ready: true,
          pane,
          paneSize: () => pane,
          applyViewport: (next: Viewport) => {
            client.viewport = next;
          },
          clearOpeningFit: () => undefined,
        } as CanvasFollowInput);
        usePublishPresence({
          awareness,
          sources: { selectedIds: [], pickSession: null, focusTargetId: null },
          synced: true,
          containerRef: { current: container },
          toFlowPosition: (point) => point,
          readCamera: () => visibleRect(client.viewport, pane),
          followCamera: follow.followCamera,
        });
        return follow;
      },
      { initialProps: { leader: null as string | null } },
    );
    client.rerender = (props) => act(() => hook.rerender(props));
    client.followCamera = () => hook.result.current.followCamera;
    return client;
  }

  /**
   * The rectangle a client has published, without its stamp.
   * @param client - The client.
   * @returns The rectangle, or null.
   */
  function publishedRect(client: Client): FlowRect | null {
    const camera = (client.awareness.getLocalState() as { camera?: (FlowRect & { at: number }) | null } | null)?.camera;
    return camera ? { x: camera.x, y: camera.y, width: camera.width, height: camera.height } : null;
  }

  /**
   * Wait until a client has published what its viewport or its following says.
   * @param client - The client.
   */
  async function untilPublished(client: Client): Promise<void> {
    await vi.waitFor(() => {
      const want = client.followCamera() ?? visibleRect(client.viewport, client.pane);
      expect(publishedRect(client)).toEqual({ x: want.x, y: want.y, width: want.width, height: want.height });
    });
  }

  /**
   * Both clients' states cross on the wire: each receives what the other had
   * published before either has answered. The store holds one target per test
   * process, so it is set to the receiving client's leader for its delivery.
   * @param a - One client, following `b`.
   * @param b - The other, following `a`.
   */
  function crossDeliver(a: Client, b: Client): void {
    const toB = encodeAwarenessUpdate(a.awareness, [a.awareness.clientID]);
    const toA = encodeAwarenessUpdate(b.awareness, [b.awareness.clientID]);
    act(() => {
      useFollowStore.setState({ targetUserId: a.userId });
      applyAwarenessUpdate(b.awareness, toB, 'remote');
      useFollowStore.setState({ targetUserId: b.userId });
      applyAwarenessUpdate(a.awareness, toA, 'remote');
    });
  }

  it('settles both on one rectangle when each presses View on the other within one round trip', async () => {
    useFollowStore.getState().reset();
    const a = mountClient('a', { width: 1000, height: 500 }, { x: -40, y: -30, zoom: 1 });
    await untilPublished(a);
    // Distinct stamps for the two own rectangles.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = mountClient('b', { width: 600, height: 900 }, { x: 200, y: 100, zoom: 0.5 });
    await untilPublished(b);
    crossDeliver(a, b);

    // Both start following before either sees the other's relay.
    useFollowStore.setState({ targetUserId: 'b' });
    a.rerender({ leader: 'b' });
    useFollowStore.setState({ targetUserId: 'a' });
    b.rerender({ leader: 'a' });
    await untilPublished(a);
    await untilPublished(b);

    for (let round = 0; round < 4; round += 1) {
      crossDeliver(a, b);
      await untilPublished(a);
      await untilPublished(b);
    }
    expect(publishedRect(a)).not.toBeNull();
    expect(publishedRect(a)).toEqual(publishedRect(b));
  });
});
