// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasRevealReceiver } from '@web/spaces/canvas/use-canvas-reveal-receiver';
import { useCanvasRevealStore } from '@web/stores/canvas-reveal';

beforeEach(() => { useCanvasRevealStore.setState({ request: null }); });

describe('a canvas taking up a "View" press (#1411 design 5.4)', () => {
  it('reveals the node once loaded and the node is there, then clears the mailbox', () => {
    const reveal = vi.fn();
    const { rerender } = renderHook(({ ready, has }) => useCanvasRevealReceiver('c1', ready, (id) => has && id === 'n1', reveal), { initialProps: { ready: false, has: false } });
    act(() => useCanvasRevealStore.getState().reveal('c1', 'n1'));
    expect(reveal).not.toHaveBeenCalled();
    rerender({ ready: true, has: false });
    expect(reveal).not.toHaveBeenCalled();
    rerender({ ready: true, has: true });
    expect(reveal).toHaveBeenCalledWith('n1');
    expect(useCanvasRevealStore.getState().request).toBeNull();
  });

  it('leaves a request for another canvas alone', () => {
    const reveal = vi.fn();
    renderHook(() => useCanvasRevealReceiver('c1', true, () => true, reveal));
    act(() => useCanvasRevealStore.getState().reveal('c2', 'n1'));
    expect(reveal).not.toHaveBeenCalled();
    expect(useCanvasRevealStore.getState().request).toEqual({ spaceId: 'c2', nodeId: 'n1' });
  });
});
