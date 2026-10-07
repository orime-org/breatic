// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A canvas's session — its open panel, its pick, its note drafts — belongs to
 * that canvas alone (inner#1235 §5.2). Several canvases stay mounted while
 * their tabs are open, so each has its own store, and the chrome outside any
 * canvas reaches the active one through a registry keyed by Space id.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  createCanvasSessionStore,
  canvasSessions,
} from '@web/stores/canvas-session';

describe('canvas session store', () => {
  beforeEach(() => {
    canvasSessions.clear();
  });

  it('keeps one canvas panel and pick to itself', () => {
    const a = createCanvasSessionStore();
    const b = createCanvasSessionStore();

    a.getState().openGeneratePanel('node-a', 'image');
    b.getState().startReferencePick('node-b');

    expect(a.getState().panelHostId).toBe('node-a');
    expect(a.getState().pickSession).toBeNull();
    expect(b.getState().panelHostId).toBeNull();
    expect(b.getState().pickSession).toEqual({ nodeId: 'node-b', purpose: 'reference' });
  });

  it('lets the note tool and a pick claim the next click one at a time', () => {
    const store = createCanvasSessionStore();

    store.getState().startAnnotationPlacement();
    store.getState().startReferencePick('node-a');
    expect(store.getState().placingAnnotation).toBe(false);
    expect(store.getState().pickSession).toEqual({ nodeId: 'node-a', purpose: 'reference' });

    store.getState().startAnnotationPlacement();
    expect(store.getState().placingAnnotation).toBe(true);
    expect(store.getState().pickSession).toBeNull();
  });

  it('gives each opening of a panel its own session, so a late submit only closes its own', () => {
    const store = createCanvasSessionStore();

    store.getState().openGeneratePanel('node-a', 'image');
    const first = store.getState().panelSession;
    store.getState().closeActivePanel();
    store.getState().openGeneratePanel('node-a', 'image');
    const second = store.getState().panelSession;

    expect(second).not.toBe(first);
    store.getState().closePanelOfSession(first);
    expect(store.getState().panelHostId).toBe('node-a');
    store.getState().closePanelOfSession(second);
    expect(store.getState().panelHostId).toBeNull();
  });

  it('keeps the opening when the panel already open is chosen again on its host', () => {
    // Re-choosing Generate on the node whose panel is open is the same panel;
    // a new session would end the prompt editor and its undo history.
    const store = createCanvasSessionStore();
    store.getState().openGeneratePanel('node-a', 'image');
    const first = store.getState().panelSession;

    store.getState().startReferencePick('node-a');
    store.getState().openGeneratePanel('node-a', 'image');

    expect(store.getState().panelSession).toBe(first);
    expect(store.getState().pickSession).toBeNull();
    store.getState().openHistoryPanel('node-a');
    expect(store.getState().panelSession).not.toBe(first);
    const history = store.getState().panelSession;
    store.getState().openHistoryPanel('node-b');
    expect(store.getState().panelSession).not.toBe(history);
  });

  it('keeps one store per Space until the Space is dropped', () => {
    const a = canvasSessions.of('space-a');

    expect(canvasSessions.of('space-a')).toBe(a);
    expect(canvasSessions.of('space-b')).not.toBe(a);

    canvasSessions.drop('space-a');
    expect(canvasSessions.of('space-a')).not.toBe(a);
  });

  it('holds one text node being written, and lets only that one end it', () => {
    const store = createCanvasSessionStore();

    store.getState().startTextEdit('a');
    store.getState().endTextEdit('b');
    expect(store.getState().editingTextNode).toBe('a');

    store.getState().startTextEdit('b');
    expect(store.getState().editingTextNode).toBe('b');
    store.getState().endTextEdit('b');
    expect(store.getState().editingTextNode).toBeNull();
  });
});

describe('mini-tool draft (inner#888 §7.2)', () => {
  const OPEN = { sourceContent: 'https://cdn.example/a.png', params: { creativity: 0 } };

  it('opens the tool panel with a fresh draft built from what the caller resolved', () => {
    const store = createCanvasSessionStore();

    store.getState().openMiniTool('node-a', 'image.upscale', OPEN);

    expect(store.getState().panelHostId).toBe('node-a');
    expect(store.getState().panelKind).toBe('miniTool');
    expect(store.getState().miniTool).toEqual({
      toolId: 'image.upscale',
      sourceContent: 'https://cdn.example/a.png',
      prompt: '',
      params: { creativity: 0 },
      slots: {},
    });
  });

  it('keeps the draft and the opening when the same tool is chosen again on its node', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.upscale', OPEN);
    store.getState().setMiniToolParam('creativity', 4);
    const session = store.getState().panelSession;

    store.getState().openMiniTool('node-a', 'image.upscale', OPEN);

    expect(store.getState().panelSession).toBe(session);
    expect(store.getState().miniTool?.params).toEqual({ creativity: 4 });
  });

  it('starts a new opening with a fresh draft when the tool changes', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.upscale', OPEN);
    store.getState().setMiniToolPrompt('sharper');
    const session = store.getState().panelSession;

    store.getState().openMiniTool('node-a', 'image.remove-bg', {
      sourceContent: OPEN.sourceContent,
      params: {},
    });

    expect(store.getState().panelSession).not.toBe(session);
    expect(store.getState().miniTool).toMatchObject({
      toolId: 'image.remove-bg',
      prompt: '',
      params: {},
    });
  });

  it('starts a new opening when the same tool opens on another node', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.upscale', OPEN);
    store.getState().setMiniToolParam('creativity', 4);
    const session = store.getState().panelSession;

    store.getState().openMiniTool('node-b', 'image.upscale', OPEN);

    expect(store.getState().panelSession).not.toBe(session);
    expect(store.getState().miniTool?.params).toEqual({ creativity: 0 });
  });

  it('drops the draft when another panel takes the slot or the panel closes', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.upscale', OPEN);
    store.getState().openGeneratePanel('node-a', 'image');
    expect(store.getState().miniTool).toBeNull();

    store.getState().openMiniTool('node-a', 'image.upscale', OPEN);
    store.getState().closeActivePanel();
    expect(store.getState().miniTool).toBeNull();
    expect(store.getState().panelKind).toBeNull();
  });

  it('replaces a single slot and appends to a many slot', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.digital-human', OPEN);

    store.getState().fillMiniToolSlot('audio', { url: 'a1.mp3', duration: 3 }, false);
    store.getState().fillMiniToolSlot('audio', { url: 'a2.mp3', duration: 5 }, false);
    store.getState().fillMiniToolSlot('refs', { url: 'r1.png' }, true);
    store.getState().fillMiniToolSlot('refs', { url: 'r2.png' }, true);

    expect(store.getState().miniTool?.slots).toEqual({
      audio: { url: 'a2.mp3', duration: 5 },
      refs: [{ url: 'r1.png' }, { url: 'r2.png' }],
    });
  });

  it('picks for a tool slot under its own purpose, carrying the slot and its cap', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.digital-human', OPEN);

    store.getState().startMiniToolSlotPick('node-a', 'audio', 1);

    expect(store.getState().pickSession).toEqual({
      nodeId: 'node-a',
      purpose: 'miniToolSlot',
      slotKey: 'audio',
      capacity: 1,
    });
    expect(store.getState().panelKind).toBe('miniTool');
  });
});

describe('history focus (inner#888 §7.7)', () => {
  it('opens history focused on the entry View asked for', () => {
    const store = createCanvasSessionStore();

    store.getState().openHistoryPanel('node-a', 'h-1');

    expect(store.getState().panelKind).toBe('history');
    expect(store.getState().historyFocus).toBe('h-1');
  });

  it('holds no focus when history is opened without one', () => {
    const store = createCanvasSessionStore();
    store.getState().openHistoryPanel('node-a', 'h-1');

    store.getState().openHistoryPanel('node-b');

    expect(store.getState().historyFocus).toBeNull();
  });

  it('drops the focus when another panel opens or the panel closes', () => {
    const store = createCanvasSessionStore();
    store.getState().openHistoryPanel('node-a', 'h-1');
    store.getState().openGeneratePanel('node-a', 'image');
    expect(store.getState().historyFocus).toBeNull();

    store.getState().openHistoryPanel('node-a', 'h-1');
    store.getState().closeActivePanel();
    expect(store.getState().historyFocus).toBeNull();
  });
});
