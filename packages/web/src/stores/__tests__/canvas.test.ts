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
