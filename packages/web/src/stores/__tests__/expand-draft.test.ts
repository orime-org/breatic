// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { createCanvasSessionStore } from '@web/stores/canvas-session';
import { UNIT_FRAME } from '@web/stores/expand-draft';

const OPEN = { sourceContent: 'https://cdn.example.com/a.png', params: {} };
const GROWN = { x: -0.2, y: -0.1, width: 1.4, height: 1.2 };

describe('the expand draft', () => {
  it('opens the expand tool with the frame at the source and the ratio free', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.expand', OPEN);
    expect(store.getState().miniTool?.expand).toEqual({ frame: UNIT_FRAME, ratio: 'free', view: null });
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
    expect(store.getState().miniTool?.expand).toEqual({ frame: UNIT_FRAME, ratio: 'free', view: null });
  });

  it('keeps the target frame geometry across successive background moves', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.expand', OPEN);
    store.getState().setExpand({ frame: GROWN, ratio: 'free' });
    const moved = { ...GROWN, x: -0.1 };
    store.getState().setExpand({ frame: moved, ratio: 'free' });
    expect(store.getState().miniTool?.expand).toEqual({ frame: moved, ratio: 'free', view: null });
  });

  it('replaces target geometry when a ratio resets the frame', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.expand', OPEN);
    store.getState().setExpand({ frame: GROWN, ratio: 'free' });
    store.getState().setExpand({ frame: UNIT_FRAME, ratio: '1:1' });
    expect(store.getState().miniTool?.expand).toEqual({ frame: UNIT_FRAME, ratio: '1:1', view: null });
  });

  it('keeps target geometry when Free leaves the frame as it was', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.expand', OPEN);
    store.getState().setExpand({ frame: GROWN, ratio: '16:9' });
    store.getState().setExpand({ frame: GROWN, ratio: 'free' });
    expect(store.getState().miniTool?.expand).toEqual({ frame: GROWN, ratio: 'free', view: null });
  });

  it('holds where the node shows the picture, for the frame drawn outside the node', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.expand', OPEN);
    const view = { at: { x: 0, y: 24 }, box: { width: 400, height: 300 }, src: 'https://cdn.example.com/a.png' };
    store.getState().setExpandView(view);
    expect(store.getState().miniTool?.expand?.view).toEqual(view);
  });
});
