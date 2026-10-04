// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Expanding an annotation is the fifth panel in the one exclusive node-anchored
 * slot (#1881 §8.7.3). It is local state and never Yjs: which note this reader
 * has open is nobody else's business.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { canvasSessions } from '@web/stores/canvas-session';

describe('the slot an expanded annotation lives in', () => {
  beforeEach(() => {
    canvasSessions.of('s').setState({
      panelHostId: null,
      panelKind: null,
      taskPanelStatus: null,
      pickSession: null,
    });
  });

  it('opens on the node asked for', () => {
    canvasSessions.of('s').getState().openAnnotationPanel('note-1');
    const s = canvasSessions.of('s').getState();
    expect(s.panelHostId).toBe('note-1');
    expect(s.panelKind).toBe('annotation');
  });

  it('replaces whatever panel was open, on any node', () => {
    canvasSessions.of('s').getState().openHistoryPanel('image-1');
    canvasSessions.of('s').getState().openAnnotationPanel('note-1');
    const s = canvasSessions.of('s').getState();
    expect(s.panelHostId).toBe('note-1');
    expect(s.panelKind).toBe('annotation');
  });

  it('is replaced in turn by another panel', () => {
    canvasSessions.of('s').getState().openAnnotationPanel('note-1');
    canvasSessions.of('s').getState().openHistoryPanel('image-1');
    const s = canvasSessions.of('s').getState();
    expect(s.panelHostId).toBe('image-1');
    expect(s.panelKind).toBe('history');
  });

  it('only one note is open at a time', () => {
    canvasSessions.of('s').getState().openAnnotationPanel('note-1');
    canvasSessions.of('s').getState().openAnnotationPanel('note-2');
    expect(canvasSessions.of('s').getState().panelHostId).toBe('note-2');
  });

  it('exits a pick in progress, the way every other opener does', () => {
    // A stale pick would wire the next click to the previous node.
    canvasSessions.of('s').getState().startReferencePick('image-1');
    canvasSessions.of('s').getState().openAnnotationPanel('note-1');
    expect(canvasSessions.of('s').getState().pickSession).toBeNull();
  });

  it('closes with the one close every panel shares', () => {
    canvasSessions.of('s').getState().openAnnotationPanel('note-1');
    canvasSessions.of('s').getState().closeActivePanel();
    const s = canvasSessions.of('s').getState();
    expect(s.panelHostId).toBeNull();
    expect(s.panelKind).toBeNull();
  });
});
