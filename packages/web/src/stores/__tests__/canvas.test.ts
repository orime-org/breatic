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
      minimapVisible: true,
      snapToGrid: false,
      showLockedOverlay: false,
      pendingNodeCreate: null,
      pendingUploadFiles: null,
      pendingViewportCommand: null,
      pendingHistoryCommand: null,
      canUndo: false,
      canRedo: false,
    });
  });

  it('initial state has empty selection and zoom=1', () => {
    const s = useCanvasStore.getState();
    expect(s.selectedNodeIds).toEqual([]);
    expect(s.hoverNodeId).toBeNull();
    expect(s.zoom).toBe(1);
  });

  it('minimap is visible by default — the built map ships on (#1548, single source of truth)', () => {
    expect(useCanvasStore.getInitialState().minimapVisible).toBe(true);
  });

  it('addSelectedNodeId is idempotent (no dup)', () => {
    useCanvasStore.getState().addSelectedNodeId('n1');
    useCanvasStore.getState().addSelectedNodeId('n1');
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['n1']);
  });

  it('toggleMinimap flips visible flag', () => {
    useCanvasStore.getState().toggleMinimap();
    expect(useCanvasStore.getState().minimapVisible).toBe(false);
    useCanvasStore.getState().toggleMinimap();
    expect(useCanvasStore.getState().minimapVisible).toBe(true);
  });

  // Snap-to-grid is a per-user viewport toggle in the same single source of
  // truth as the minimap (#1548 pattern), so CanvasSpace can subscribe and feed
  // it to ReactFlow. It starts OFF: free placement is the default, snapping is
  // opt-in (unlike the minimap, which is a view aid that ships on).
  it('snap-to-grid is OFF by default (free placement; snapping is opt-in)', () => {
    expect(useCanvasStore.getInitialState().snapToGrid).toBe(false);
  });

  it('toggleSnapToGrid flips the flag', () => {
    useCanvasStore.getState().toggleSnapToGrid();
    expect(useCanvasStore.getState().snapToGrid).toBe(true);
    useCanvasStore.getState().toggleSnapToGrid();
    expect(useCanvasStore.getState().snapToGrid).toBe(false);
  });

  it('setSnapToGrid sets the flag explicitly', () => {
    useCanvasStore.getState().setSnapToGrid(true);
    expect(useCanvasStore.getState().snapToGrid).toBe(true);
  });

  it('requestRename posts a node id; consumePendingRename clears it', () => {
    useCanvasStore.getState().requestRename('n-7');
    expect(useCanvasStore.getState().pendingRename).toBe('n-7');
    useCanvasStore.getState().consumePendingRename();
    expect(useCanvasStore.getState().pendingRename).toBeNull();
  });

  it('clearSelection empties the array', () => {
    useCanvasStore.getState().setSelectedNodeIds(['a', 'b']);
    useCanvasStore.getState().clearSelection();
    expect(useCanvasStore.getState().selectedNodeIds).toEqual([]);
  });

  it('requestNodeCreate queues a pending create that consume clears (chrome → canvas mailbox)', () => {
    expect(useCanvasStore.getState().pendingNodeCreate).toBeNull();
    useCanvasStore.getState().requestNodeCreate('image');
    expect(useCanvasStore.getState().pendingNodeCreate).toBe('image');
    useCanvasStore.getState().consumePendingNodeCreate();
    expect(useCanvasStore.getState().pendingNodeCreate).toBeNull();
  });

  it('requestUpload queues picked files that consume clears (chrome → canvas upload mailbox)', () => {
    expect(useCanvasStore.getState().pendingUploadFiles).toBeNull();
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    useCanvasStore.getState().requestUpload([file]);
    expect(useCanvasStore.getState().pendingUploadFiles).toEqual([file]);
    useCanvasStore.getState().consumePendingUpload();
    expect(useCanvasStore.getState().pendingUploadFiles).toBeNull();
  });

  it('requestViewportCommand queues a zoom command that consume clears (chrome → canvas mailbox)', () => {
    expect(useCanvasStore.getState().pendingViewportCommand).toBeNull();
    useCanvasStore.getState().requestViewportCommand('zoomIn');
    expect(useCanvasStore.getState().pendingViewportCommand).toBe('zoomIn');
    useCanvasStore.getState().requestViewportCommand({ zoomTo: 1.5 });
    expect(useCanvasStore.getState().pendingViewportCommand).toEqual({
      zoomTo: 1.5,
    });
    useCanvasStore.getState().consumeViewportCommand();
    expect(useCanvasStore.getState().pendingViewportCommand).toBeNull();
  });

  it('requestHistoryCommand queues an undo/redo command that consume clears (chrome → canvas mailbox)', () => {
    expect(useCanvasStore.getState().pendingHistoryCommand).toBeNull();
    useCanvasStore.getState().requestHistoryCommand('undo');
    expect(useCanvasStore.getState().pendingHistoryCommand).toBe('undo');
    useCanvasStore.getState().requestHistoryCommand('redo');
    expect(useCanvasStore.getState().pendingHistoryCommand).toBe('redo');
    useCanvasStore.getState().consumeHistoryCommand();
    expect(useCanvasStore.getState().pendingHistoryCommand).toBeNull();
  });

  it('setHistoryAvailability mirrors the canvas undo manager flags (canvas → chrome)', () => {
    expect(useCanvasStore.getState().canUndo).toBe(false);
    expect(useCanvasStore.getState().canRedo).toBe(false);
    useCanvasStore.getState().setHistoryAvailability(true, false);
    expect(useCanvasStore.getState().canUndo).toBe(true);
    expect(useCanvasStore.getState().canRedo).toBe(false);
    useCanvasStore.getState().setHistoryAvailability(false, true);
    expect(useCanvasStore.getState().canUndo).toBe(false);
    expect(useCanvasStore.getState().canRedo).toBe(true);
  });
});
