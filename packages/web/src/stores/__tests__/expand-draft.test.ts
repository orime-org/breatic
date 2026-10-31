// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import { createCanvasSessionStore } from '@web/stores/canvas-session';
import { UNIT_FRAME } from '@web/stores/expand-draft';

const OPEN = { sourceContent: 'https://cdn.example.com/a.png', params: {} };
const GROWN = { x: -0.2, y: -0.1, width: 1.4, height: 1.2 };

describe('the expand draft', () => {
  it('opens the expand tool with the frame at the source and the ratio free', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.expand', OPEN);
    expect(store.getState().miniTool?.expand).toEqual({ frame: UNIT_FRAME, ratio: 'free', shift: { x: 0, y: 0 }, view: null });
  });

  it('holds no frame on another tool', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.crop', OPEN);
    expect(store.getState().miniTool?.expand).toBeNull();
  });

  it('takes a frame and a ratio together', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.expand', OPEN);
    store.getState().setExpand({ frame: GROWN, ratio: '1:1' });
    expect(store.getState().miniTool?.expand).toMatchObject({ frame: GROWN, ratio: '1:1' });
  });

  it('puts the frame back at the source and the ratio back to free when the source changes', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.expand', OPEN);
    store.getState().setExpand({ frame: GROWN, ratio: '16:9' });
    store.getState().resetMiniToolSource('https://cdn.example.com/b.png', {});
    expect(store.getState().miniTool?.expand).toEqual({ frame: UNIT_FRAME, ratio: 'free', shift: { x: 0, y: 0 }, view: null });
  });

  // The picture's move lives with the frame, so a node drawn again (panned off
  // and back) shows the frame and the picture where they were.
  it('keeps how far the picture moved with the frame a drag writes', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.expand', OPEN);
    store.getState().setExpand({ frame: GROWN, ratio: 'free', shift: { x: 0.1, y: 0 } });
    expect(store.getState().miniTool?.expand?.shift).toEqual({ x: 0.1, y: 0 });
  });

  // A ratio preset or a reset wraps the frame around the picture where the node shows it.
  it('puts the picture back over the node when anything but a drag changes the frame', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.expand', OPEN);
    store.getState().setExpand({ frame: GROWN, ratio: 'free', shift: { x: 0.1, y: 0 } });
    store.getState().setExpand({ frame: UNIT_FRAME, ratio: '1:1' });
    expect(store.getState().miniTool?.expand?.shift).toEqual({ x: 0, y: 0 });
  });

  // Free leaves the frame as it was, and the picture with it.
  it('keeps the move when a write leaves the frame as it was', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.expand', OPEN);
    store.getState().setExpand({ frame: GROWN, ratio: '16:9', shift: { x: 0.1, y: 0 } });
    store.getState().setExpand({ frame: GROWN, ratio: 'free' });
    expect(store.getState().miniTool?.expand?.shift).toEqual({ x: 0.1, y: 0 });
  });

  it('holds where the node shows the picture, for the frame drawn outside the node', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.expand', OPEN);
    const view = { at: { x: 0, y: 24 }, box: { width: 400, height: 300 }, src: 'https://cdn.example.com/a.png' };
    store.getState().setExpandView(view);
    expect(store.getState().miniTool?.expand?.view).toEqual(view);
  });
});
