// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import { useCanvasStore } from '@web/stores/canvas';

describe('useCanvasStore', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      selectedNodeIds: [],
      hoverNodeId: null,
      zoom: 1,
      minimapVisible: false,
      showLockedOverlay: false,
    });
  });

  it('initial state has empty selection and zoom=1', () => {
    const s = useCanvasStore.getState();
    expect(s.selectedNodeIds).toEqual([]);
    expect(s.hoverNodeId).toBeNull();
    expect(s.zoom).toBe(1);
    expect(s.minimapVisible).toBe(false);
  });

  it('addSelectedNodeId is idempotent (no dup)', () => {
    useCanvasStore.getState().addSelectedNodeId('n1');
    useCanvasStore.getState().addSelectedNodeId('n1');
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['n1']);
  });

  it('toggleMinimap flips visible flag', () => {
    useCanvasStore.getState().toggleMinimap();
    expect(useCanvasStore.getState().minimapVisible).toBe(true);
    useCanvasStore.getState().toggleMinimap();
    expect(useCanvasStore.getState().minimapVisible).toBe(false);
  });

  it('clearSelection empties the array', () => {
    useCanvasStore.getState().setSelectedNodeIds(['a', 'b']);
    useCanvasStore.getState().clearSelection();
    expect(useCanvasStore.getState().selectedNodeIds).toEqual([]);
  });
});
