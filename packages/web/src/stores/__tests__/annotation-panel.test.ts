// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Expanding an annotation is the fifth panel in the one exclusive node-anchored
 * slot (#1881 §8.7.3). It is local state and never Yjs: which note this reader
 * has open is nobody else's business.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { useCanvasStore } from '@web/stores/canvas';

describe('the slot an expanded annotation lives in', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      panelHostId: null,
      panelKind: null,
      taskPanelStatus: null,
      pickSession: null,
    });
  });

  it('opens on the node asked for', () => {
    useCanvasStore.getState().openAnnotationPanel('note-1');
    const s = useCanvasStore.getState();
    expect(s.panelHostId).toBe('note-1');
    expect(s.panelKind).toBe('annotation');
  });

  it('replaces whatever panel was open, on any node', () => {
    useCanvasStore.getState().openHistoryPanel('image-1');
    useCanvasStore.getState().openAnnotationPanel('note-1');
    const s = useCanvasStore.getState();
    expect(s.panelHostId).toBe('note-1');
    expect(s.panelKind).toBe('annotation');
  });

  it('is replaced in turn by another panel', () => {
    useCanvasStore.getState().openAnnotationPanel('note-1');
    useCanvasStore.getState().openHistoryPanel('image-1');
    const s = useCanvasStore.getState();
    expect(s.panelHostId).toBe('image-1');
    expect(s.panelKind).toBe('history');
  });

  it('only one note is open at a time', () => {
    useCanvasStore.getState().openAnnotationPanel('note-1');
    useCanvasStore.getState().openAnnotationPanel('note-2');
    expect(useCanvasStore.getState().panelHostId).toBe('note-2');
  });

  it('exits a pick in progress, the way every other opener does', () => {
    // A stale pick would wire the next click to the previous node.
    useCanvasStore.getState().startReferencePick('image-1');
    useCanvasStore.getState().openAnnotationPanel('note-1');
    expect(useCanvasStore.getState().pickSession).toBeNull();
  });

  it('closes with the one close every panel shares', () => {
    useCanvasStore.getState().openAnnotationPanel('note-1');
    useCanvasStore.getState().closeActivePanel();
    const s = useCanvasStore.getState();
    expect(s.panelHostId).toBeNull();
    expect(s.panelKind).toBeNull();
  });
});
