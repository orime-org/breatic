// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { useCanvasRevealRouting } from '@web/pages/project/use-canvas-reveal-routing';
import { useCanvasRevealStore } from '@web/stores/canvas-reveal';

const SPACES: ProjectSpace[] = [
  { id: 'c1', name: 'Board', type: 'canvas' },
  { id: 'd1', name: 'Notes', type: 'document' },
];

beforeEach(() => { useCanvasRevealStore.setState({ request: null }); });

describe('routing a "View" press to its canvas (#1411 design 5.4)', () => {
  it('opens or switches to the canvas the request names, once the Spaces have arrived', () => {
    const open = vi.fn();
    const { rerender } = renderHook(({ ready }) => useCanvasRevealRouting(SPACES, 'd1', open, ready), { initialProps: { ready: false } });
    act(() => useCanvasRevealStore.getState().reveal('c1', 'n1'));
    expect(open).not.toHaveBeenCalled();
    rerender({ ready: true });
    expect(open).toHaveBeenCalledWith('c1');
    expect(useCanvasRevealStore.getState().request).toEqual({ spaceId: 'c1', nodeId: 'n1' });
  });

  it('does not reopen a canvas already in front, leaving the request for it', () => {
    const open = vi.fn();
    renderHook(() => useCanvasRevealRouting(SPACES, 'c1', open, true));
    act(() => useCanvasRevealStore.getState().reveal('c1', 'n1'));
    expect(open).not.toHaveBeenCalled();
    expect(useCanvasRevealStore.getState().request).not.toBeNull();
  });

  it('opens the canvas once, and drops the request when the user moves to another tab after it came to the front', () => {
    const open = vi.fn();
    const { rerender } = renderHook(({ active }) => useCanvasRevealRouting(SPACES, active, open, true), { initialProps: { active: 'd1' as string | null } });
    act(() => useCanvasRevealStore.getState().reveal('c1', 'gone-node'));
    expect(open).toHaveBeenCalledTimes(1);
    rerender({ active: 'c1' });
    rerender({ active: 'd1' });
    expect(open).toHaveBeenCalledTimes(1);
    expect(useCanvasRevealStore.getState().request).toBeNull();
  });

  it('drops a request for a Space that is gone or is not a canvas', () => {
    const open = vi.fn();
    renderHook(() => useCanvasRevealRouting(SPACES, null, open, true));
    act(() => useCanvasRevealStore.getState().reveal('d1', 'n1'));
    expect(useCanvasRevealStore.getState().request).toBeNull();
    act(() => useCanvasRevealStore.getState().reveal('gone', 'n1'));
    expect(useCanvasRevealStore.getState().request).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});
