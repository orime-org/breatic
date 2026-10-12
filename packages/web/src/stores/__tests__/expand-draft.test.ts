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
    expect(store.getState().miniTool?.expand).toEqual({ frame: UNIT_FRAME, ratio: 'free', cap: null, drop: 0 });
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
    store.getState().setExpandCap(12288);
    store.getState().setExpand({ frame: GROWN, ratio: '16:9' });
    store.getState().resetMiniToolSource('https://cdn.example.com/b.png', {});
    expect(store.getState().miniTool?.expand).toEqual({ frame: UNIT_FRAME, ratio: 'free', cap: 12288, drop: 0 });
  });
});
